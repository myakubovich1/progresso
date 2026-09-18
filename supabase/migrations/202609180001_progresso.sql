-- Progresso: all application access uses the authenticated user's JWT, never service_role.
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 80),
  age_range text not null check (age_range in ('18-24','25-34','35-44','45-54','55-64','65+')),
  height_cm numeric check (height_cm between 50 and 280),
  weight_kg numeric check (weight_kg between 20 and 700),
  activity_level text not null check (activity_level in ('sedentary','light','moderate','active','very_active')),
  preferred_units text not null check (preferred_units in ('metric','imperial')),
  timezone text not null default 'UTC', onboarding_completed boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.goals (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  goal text not null check (goal in ('sleep','fitness','weight_loss','muscle_gain','energy','cardio','general_health')),
  priority integer not null check (priority between 1 and 7), created_at timestamptz not null default now(),
  unique(user_id, goal), unique(user_id, priority)
);
create table public.uploads (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null check (length(filename) between 1 and 180), mime_type text not null,
  size_bytes integer not null check (size_bytes between 1 and 4194304), sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null check (storage_path like user_id::text || '/%'),
  kind text not null check (kind in ('health','meal')),
  status text not null default 'pending' check (status in ('pending','review','confirmed','failed')),
  extraction jsonb, error text, created_at timestamptz not null default now(),
  unique(id,user_id), unique(user_id,sha256,kind)
);
create table public.meals (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  date date not null, name text not null check (length(name) between 1 and 120), items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30),
  calories numeric not null check (calories between 0 and 30000), protein numeric not null check (protein between 0 and 2000),
  carbs numeric not null check (carbs between 0 and 5000), fat numeric not null check (fat between 0 and 2000),
  raw_upload_id uuid, is_demo boolean not null default false, created_at timestamptz not null default now(),
  unique(id,user_id), unique(raw_upload_id),
  foreign key(raw_upload_id,user_id) references public.uploads(id,user_id)
);
create function public.valid_health_metric(m text, c text, u text, v numeric) returns boolean language sql immutable set search_path = '' as $$
  select case m
    when 'sleep_duration' then c='sleep' and u='h' and v<=24
    when 'steps' then c='movement' and u='steps' and v<=200000
    when 'cardio_minutes' then c='cardio' and u='min' and v<=1440
    when 'strength_minutes' then c='strength' and u='min' and v<=1440
    when 'calories' then c='nutrition' and u='kcal' and v<=30000
    when 'protein' then c='nutrition' and u='g' and v<=2000
    when 'carbs' then c='nutrition' and u='g' and v<=5000
    when 'fat' then c='nutrition' and u='g' and v<=2000
    when 'weight' then c='body_metrics' and u='kg' and v<=700
    when 'resting_heart_rate' then c='recovery' and u='bpm' and v<=300
    when 'hrv' then c='recovery' and u='ms' and v<=1000
    when 'recovery_score' then c='recovery' and u='%' and v<=100
    else c='other' end;
$$;
create table public.health_records (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  date date not null, category text not null check (category in ('sleep','movement','cardio','strength','nutrition','recovery','body_metrics','other')),
  metric text not null check (metric ~ '^[a-z][a-z0-9_]{0,79}$'), value numeric not null check (value between 0 and 1000000000),
  unit text not null check (length(unit) between 1 and 24), source text not null check (length(source) between 1 and 120),
  confidence numeric not null check (confidence between 0 and 1), is_demo boolean not null default false,
  raw_upload_id uuid, meal_id uuid, fingerprint text not null,
  created_at timestamptz not null default now(), unique(user_id,fingerprint),
  foreign key(raw_upload_id,user_id) references public.uploads(id,user_id),
  foreign key(meal_id,user_id) references public.meals(id,user_id) on delete cascade,
  check (public.valid_health_metric(metric,category,unit,value))
);
create table public.recommendations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('sleep','movement','cardio','strength','nutrition','recovery','body_metrics','other')),
  title text not null, why text not null, target numeric not null check (target > 0 and target <= 10000),
  progress_unit text not null, evidence jsonb not null default '[]', starts_on date not null, ends_on date not null,
  status text not null default 'active' check (status in ('active','completed','dismissed')),
  is_demo boolean not null default false, created_at timestamptz not null default now(),
  unique(id,user_id), check (ends_on >= starts_on)
);
create unique index recommendations_one_active on public.recommendations(user_id) where status='active';
create table public.recommendation_progress (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  recommendation_id uuid not null, amount numeric not null check (amount > 0 and amount <= 10000),
  date date not null, note text not null default '' check (length(note)<=500), idempotency_key uuid not null,
  created_at timestamptz not null default now(), unique(user_id,idempotency_key),
  foreign key(recommendation_id,user_id) references public.recommendations(id,user_id) on delete cascade
);
create index health_records_user_date on public.health_records(user_id,date desc);
create index health_records_user_metric_date on public.health_records(user_id,metric,date);
create index uploads_user_created on public.uploads(user_id,created_at desc);
create index meals_user_date on public.meals(user_id,date desc);
create index progress_user_recommendation on public.recommendation_progress(user_id,recommendation_id);
-- RLS plus compound foreign keys prevent cross-user references, including guessed UUIDs.
do $$ declare t text; begin
  foreach t in array array['profiles','goals','uploads','health_records','meals','recommendations','recommendation_progress'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy owner_access on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',t);
    execute format('grant select,insert,update,delete on public.%I to authenticated',t);
    execute format('revoke all on public.%I from anon',t);
  end loop;
end $$;

-- All multi-table writes run inside one transaction and serialize per user.
create function public.progresso_mutate(action text, payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid := auth.uid(); obj jsonb; rec jsonb; upload public.uploads; meal public.meals;
  recommendation public.recommendations; rid uuid; total numeric; inserted integer := 0;
  i integer := 0; kcal numeric; p numeric; c numeric; f numeric; demo boolean;
begin
  if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if action='onboard' then
    insert into public.profiles(user_id,display_name,age_range,height_cm,weight_kg,activity_level,preferred_units,timezone)
    values(uid,payload->>'display_name',payload->>'age_range',(payload->>'height_cm')::numeric,(payload->>'weight_kg')::numeric,payload->>'activity_level',payload->>'preferred_units',payload->>'timezone')
    on conflict(user_id) do update set display_name=excluded.display_name,age_range=excluded.age_range,height_cm=excluded.height_cm,weight_kg=excluded.weight_kg,activity_level=excluded.activity_level,preferred_units=excluded.preferred_units,timezone=excluded.timezone,onboarding_completed=true;
    delete from public.goals where user_id=uid;
    for obj in select value from jsonb_array_elements(payload->'goals') loop
      i:=i+1; insert into public.goals(user_id,goal,priority) values(uid,obj#>>'{}',i);
    end loop;
    return jsonb_build_object('saved',true);
  elsif action in ('confirm_upload','records','seed') then
    if action='confirm_upload' then
      select * into upload from public.uploads where id=(payload->>'upload_id')::uuid and user_id=uid for update;
      if not found then raise exception 'Upload not found' using errcode='P0002'; end if;
      if upload.status='confirmed' then return jsonb_build_object('already_confirmed',true); end if;
      if upload.status<>'review' or upload.kind<>'health' then raise exception 'Upload is not ready for confirmation'; end if;
    end if;
    if action='seed' and exists(select 1 from public.health_records where user_id=uid) then return jsonb_build_object('already_seeded',true); end if;
    for obj in select value from jsonb_array_elements(payload->'records') loop
      demo := action='seed' or coalesce((obj->>'is_demo')::boolean,false) or coalesce(upload.extraction->>'mode'='demo',false);
      insert into public.health_records(user_id,date,category,metric,value,unit,source,confidence,is_demo,raw_upload_id,fingerprint)
      values(uid,(obj->>'date')::date,obj->>'category',obj->>'metric',(obj->>'value')::numeric,obj->>'unit',obj->>'source',(obj->>'confidence')::numeric,demo,upload.id,
        md5(concat_ws('|',obj->>'date',obj->>'metric',obj->>'value',obj->>'unit',obj->>'source',demo::text))) on conflict(user_id,fingerprint) do nothing;
      get diagnostics i = row_count; inserted := inserted+i;
    end loop;
    if action='confirm_upload' then update public.uploads set status='confirmed' where id=upload.id; end if;
    return jsonb_build_object('inserted',inserted);
  elsif action='save_meal' then
    if payload->>'raw_upload_id' is not null then
      select * into upload from public.uploads where id=(payload->>'raw_upload_id')::uuid and user_id=uid for update;
      if not found then raise exception 'Upload not found' using errcode='P0002'; end if;
      if upload.kind<>'meal' or upload.status not in ('review','confirmed') then raise exception 'Meal upload is not ready'; end if;
    end if;
    if payload->>'id' is not null then
      select * into meal from public.meals where id=(payload->>'id')::uuid and user_id=uid for update;
      if not found then raise exception 'Meal not found' using errcode='P0002'; end if;
      if meal.raw_upload_id is distinct from upload.id then raise exception 'Cannot replace meal source'; end if;
      rid := meal.id;
    elsif upload.id is not null then
      select * into meal from public.meals where raw_upload_id=upload.id and user_id=uid;
      if found then return to_jsonb(meal); end if;
    end if;
    rid := coalesce(rid,gen_random_uuid());
    select round(sum((v->>'calories')::numeric*(v->>'quantity')::numeric),1),round(sum((v->>'protein')::numeric*(v->>'quantity')::numeric),1),round(sum((v->>'carbs')::numeric*(v->>'quantity')::numeric),1),round(sum((v->>'fat')::numeric*(v->>'quantity')::numeric),1)
      into kcal,p,c,f from jsonb_array_elements(payload->'items') v;
    demo:=coalesce((payload->>'is_demo')::boolean,false) or coalesce(upload.extraction->>'mode'='demo',false);
    insert into public.meals(id,user_id,date,name,items,calories,protein,carbs,fat,raw_upload_id,is_demo)
    values(rid,uid,(payload->>'date')::date,payload->>'name',payload->'items',kcal,p,c,f,upload.id,demo)
    on conflict(id) do update set date=excluded.date,name=excluded.name,items=excluded.items,calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,is_demo=excluded.is_demo returning * into meal;
    delete from public.health_records where meal_id=rid and user_id=uid;
    for obj in select value from jsonb_array_elements(jsonb_build_array(jsonb_build_object('metric','calories','value',kcal,'unit','kcal'),jsonb_build_object('metric','protein','value',p,'unit','g'),jsonb_build_object('metric','carbs','value',c,'unit','g'),jsonb_build_object('metric','fat','value',f,'unit','g'))) loop
      insert into public.health_records(user_id,date,category,metric,value,unit,source,confidence,is_demo,raw_upload_id,meal_id,fingerprint)
      values(uid,meal.date,'nutrition',obj->>'metric',(obj->>'value')::numeric,obj->>'unit','Meal estimate',0.6,demo,upload.id,rid,rid::text||':'||(obj->>'metric'));
    end loop;
    if upload.id is not null then update public.uploads set status='confirmed' where id=upload.id; end if;
    return to_jsonb(meal);
  elsif action='recommend' then
    select * into recommendation from public.recommendations where user_id=uid and status='active' for update;
    if found and recommendation.ends_on >= (payload->>'starts_on')::date then return to_jsonb(recommendation); end if;
    update public.recommendations set status='dismissed' where user_id=uid and status='active';
    insert into public.recommendations(user_id,category,title,why,target,progress_unit,evidence,starts_on,ends_on,is_demo)
    values(uid,payload->>'category',payload->>'title',payload->>'why',(payload->>'target')::numeric,payload->>'progress_unit',payload->'evidence',(payload->>'starts_on')::date,(payload->>'ends_on')::date,(payload->>'is_demo')::boolean) returning * into recommendation;
    return to_jsonb(recommendation);
  elsif action='progress' then
    select to_jsonb(r) into rec from public.recommendation_progress r where user_id=uid and idempotency_key=(payload->>'idempotency_key')::uuid;
    if found then
      if rec->>'recommendation_id'<>payload->>'recommendation_id' then raise exception 'Idempotency key belongs to another recommendation'; end if;
      return rec;
    end if;
    select * into recommendation from public.recommendations where id=(payload->>'recommendation_id')::uuid and user_id=uid for update;
    if not found then raise exception 'Recommendation not found' using errcode='P0002'; end if;
    if recommendation.status<>'active' then raise exception 'Recommendation is no longer active'; end if;
    if (payload->>'date')::date not between recommendation.starts_on and recommendation.ends_on then raise exception 'Progress date is outside recommendation window'; end if;
    select coalesce(sum(amount),0) into total from public.recommendation_progress where recommendation_id=recommendation.id and user_id=uid;
    if total+(payload->>'amount')::numeric>recommendation.target then raise exception 'Progress exceeds target'; end if;
    insert into public.recommendation_progress(user_id,recommendation_id,amount,date,note,idempotency_key)
    values(uid,recommendation.id,(payload->>'amount')::numeric,(payload->>'date')::date,coalesce(payload->>'note',''),(payload->>'idempotency_key')::uuid) returning to_jsonb(recommendation_progress.*) into rec;
    if total+(payload->>'amount')::numeric>=recommendation.target then update public.recommendations set status='completed' where id=recommendation.id; end if;
    return rec;
  else raise exception 'Unknown operation'; end if;
end;
$$;
revoke all on function public.progresso_mutate(text,jsonb) from public, anon;
grant execute on function public.progresso_mutate(text,jsonb) to authenticated;

-- Private storage. No public URLs; object names start with the authenticated UUID.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('health-uploads','health-uploads',false,4194304,array['image/jpeg','image/png','image/webp','application/pdf','text/csv','application/json','application/xml'])
on conflict(id) do nothing;
create policy health_upload_read on storage.objects for select to authenticated using(bucket_id='health-uploads' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy health_upload_insert on storage.objects for insert to authenticated with check(bucket_id='health-uploads' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy health_upload_delete on storage.objects for delete to authenticated using(bucket_id='health-uploads' and (storage.foldername(name))[1]=(select auth.uid())::text);
