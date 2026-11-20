-- Survive the Island — game database
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it only creates what is missing and replaces the functions.

create extension if not exists pgcrypto;

-- ---------- settings you change by hand (Table Editor → settings) ----------
create table if not exists settings (key text primary key, value text not null);
insert into settings (key, value) values
  ('entry_code', 'COCONUT'),   -- the secret word from your latest Reel
  ('followers',  '0'),         -- type your follower count here; it unlocks island areas
  ('daily_energy','5')         -- actions each player gets per day
on conflict (key) do nothing;

-- ---------- players ----------
create table if not exists players (
  id          bigserial primary key,
  username    text unique not null check (username ~ '^[a-z0-9._]{1,30}$'),
  token       uuid not null default gen_random_uuid(),   -- secret, never shown publicly
  look        jsonb not null default '{}'::jsonb,
  wood        int not null default 0,
  fish        int not null default 0,
  stone       int not null default 0,
  energy      int not null default 5,
  energy_day  date not null default current_date,
  hut_level   int not null default 1,
  score       int not null default 0,
  invited_by  text,
  invites     int not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- Story bonus codes (Table Editor → codes) ----------
create table if not exists codes (
  code       text primary key,
  energy     int not null default 3,
  wood       int not null default 0,
  stone      int not null default 0,
  fish       int not null default 0,
  expires_at timestamptz
);
create table if not exists redeemed (
  player_id bigint references players on delete cascade,
  code      text references codes on delete cascade,
  primary key (player_id, code)
);

-- ---------- island-wide goals / events (Table Editor → goals) ----------
create table if not exists goals (
  id       bigserial primary key,
  title    text not null,
  resource text not null check (resource in ('wood','fish','stone')),
  target   int  not null,
  progress int  not null default 0,
  ends_at  timestamptz,
  active   boolean not null default true
);
create table if not exists contributions (
  goal_id   bigint references goals on delete cascade,
  player_id bigint references players on delete cascade,
  amount    int not null default 0,
  primary key (goal_id, player_id)
);

insert into goals (title, resource, target, ends_at)
select 'A storm is coming! Build the storm wall', 'wood', 500, now() + interval '7 days'
where not exists (select 1 from goals);

-- Lock every table: the website can only use the functions below.
alter table settings      enable row level security;
alter table players       enable row level security;
alter table codes         enable row level security;
alter table redeemed      enable row level security;
alter table goals         enable row level security;
alter table contributions enable row level security;

-- Public, safe view of players (no token).
create or replace view players_public as
  select username, look, hut_level, score, invites, created_at from players;
grant select on players_public to anon, authenticated;

-- ---------- helpers ----------
create or replace function _player(p_token uuid) returns players
language plpgsql security definer set search_path = public as $$
declare p players; e int;
begin
  select * into p from players where token = p_token for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p.energy_day < current_date then
    select value::int into e from settings where key = 'daily_energy';
    update players set energy = greatest(energy, coalesce(e, 5)), energy_day = current_date
      where id = p.id returning * into p;
  end if;
  return p;
end $$;

create or replace function _me_json(p players) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'username', p.username, 'look', p.look, 'wood', p.wood, 'fish', p.fish, 'stone', p.stone,
    'energy', p.energy, 'hut_level', p.hut_level, 'score', p.score, 'invites', p.invites,
    'rank', (select count(*) + 1 from players where score > p.score));
$$;

-- ---------- game actions ----------
create or replace function join_island(p_username text, p_code text, p_ref text default null, p_look jsonb default '{}'::jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare u text; r text; want text; p players; ref_ok boolean := false;
begin
  u := lower(regexp_replace(trim(coalesce(p_username,'')), '^@', ''));
  r := lower(regexp_replace(trim(coalesce(p_ref,'')), '^@', ''));
  if u !~ '^[a-z0-9._]{1,30}$' then raise exception 'BAD_NAME'; end if;
  select value into want from settings where key = 'entry_code';
  if upper(trim(coalesce(p_code,''))) <> upper(trim(coalesce(want,''))) then raise exception 'BAD_CODE'; end if;
  if exists (select 1 from players where username = u) then raise exception 'TAKEN'; end if;

  if r <> '' and r <> u and exists (select 1 from players where username = r) then
    ref_ok := true;
    update players set invites = invites + 1, wood = wood + 5, stone = stone + 2, score = score + 10 where username = r;
  end if;

  insert into players (username, look, invited_by, wood, score)
    values (u, coalesce(p_look,'{}'::jsonb), case when ref_ok then r end, case when ref_ok then 5 else 0 end, 0)
    returning * into p;
  return json_build_object('token', p.token, 'me', _me_json(p));
end $$;

create or replace function me(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
begin return _me_json(_player(p_token)); end $$;

create or replace function set_look(p_token uuid, p_look jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare p players;
begin
  p := _player(p_token);
  update players set look = coalesce(p_look,'{}'::jsonb) where id = p.id returning * into p;
  return _me_json(p);
end $$;

create or replace function do_task(p_token uuid, p_task text) returns json
language plpgsql security definer set search_path = public as $$
declare p players; w int := 0; f int := 0; s int := 0; b int := 0; msg text; roll float := random(); fl int;
begin
  p := _player(p_token);
  if p.energy <= 0 then raise exception 'NO_ENERGY'; end if;
  if p_task in ('cave','volcano','wreck') then
    select coalesce(value::int, 0) into fl from settings where key = 'followers';
    if (p_task = 'cave' and fl < 500) or (p_task = 'volcano' and fl < 1000) or (p_task = 'wreck' and fl < 2500) then
      raise exception 'LOCKED'; end if;
  end if;
  if p_task = 'chop' then
    w := 2 + floor(random()*3)::int; msg := 'You chopped ' || w || ' wood';
  elsif p_task = 'fish' then
    f := 1 + floor(random()*3)::int; msg := 'You caught ' || f || ' fish';
  elsif p_task = 'mine' then
    s := 1 + floor(random()*2)::int; msg := 'You mined ' || s || ' stone';
  elsif p_task = 'explore' then
    if roll < 0.12 then w := 6; s := 4; f := 3; msg := 'TREASURE! You found a buried chest';
    elsif roll < 0.45 then w := 1; s := 1; f := 1; msg := 'You found some supplies on the beach';
    elsif roll < 0.75 then f := 2; msg := 'You found a hidden fishing spot';
    else msg := 'Nothing here... but you heard something in the jungle'; end if;
  elsif p_task = 'cave' then
    s := 3 + floor(random()*3)::int;
    if roll < 0.2 then b := 15; msg := 'A glowing crystal! +' || s || ' stone and 15 bonus points';
    else msg := 'Deep in the cave you mined ' || s || ' stone'; end if;
  elsif p_task = 'volcano' then
    s := 2 + floor(random()*3)::int; b := 10;
    msg := 'You collected obsidian from the volcano: +' || s || ' stone, +10 points';
  elsif p_task = 'wreck' then
    w := 4 + floor(random()*3)::int; f := 1 + floor(random()*2)::int;
    if roll < 0.25 then w := w + 5; s := 3; b := 20; msg := 'PIRATE GOLD! The shipwreck was full of loot';
    else msg := 'You salvaged the shipwreck: +' || w || ' wood'; end if;
  else raise exception 'BAD_TASK'; end if;
  update players set energy = energy - 1, wood = wood + w, fish = fish + f, stone = stone + s,
    score = score + w + f*2 + s*2 + b where id = p.id returning * into p;
  return json_build_object('msg', msg, 'me', _me_json(p));
end $$;

create or replace function upgrade_hut(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare p players; cw int; cs int; cf int;
begin
  p := _player(p_token);
  if p.hut_level >= 5 then raise exception 'MAX_LEVEL'; end if;
  cw := (array[10,20,35,60])[p.hut_level];
  cs := (array[0,10,25,45])[p.hut_level];
  cf := (array[0,0,10,25])[p.hut_level];
  if p.wood < cw or p.stone < cs or p.fish < cf then raise exception 'NOT_ENOUGH'; end if;
  update players set wood = wood - cw, stone = stone - cs, fish = fish - cf,
    hut_level = hut_level + 1, score = score + 25 * (hut_level + 1) where id = p.id returning * into p;
  return _me_json(p);
end $$;

create or replace function redeem(p_token uuid, p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare p players; c codes;
begin
  p := _player(p_token);
  select * into c from codes where upper(code) = upper(trim(p_code)) and (expires_at is null or expires_at > now());
  if not found then raise exception 'BAD_CODE'; end if;
  if exists (select 1 from redeemed where player_id = p.id and code = c.code) then raise exception 'USED'; end if;
  insert into redeemed values (p.id, c.code);
  update players set energy = energy + c.energy, wood = wood + c.wood, stone = stone + c.stone, fish = fish + c.fish
    where id = p.id returning * into p;
  return _me_json(p);
end $$;

create or replace function contribute(p_token uuid, p_amount int) returns json
language plpgsql security definer set search_path = public as $$
declare p players; g goals; have int; amt int;
begin
  p := _player(p_token);
  select * into g from goals where active and (ends_at is null or ends_at > now()) and progress < target order by id desc limit 1;
  if not found then raise exception 'NO_GOAL'; end if;
  have := case g.resource when 'wood' then p.wood when 'fish' then p.fish else p.stone end;
  amt := least(greatest(coalesce(p_amount,0),0), have, g.target - g.progress);
  if amt <= 0 then raise exception 'NOT_ENOUGH'; end if;
  if g.resource = 'wood' then update players set wood = wood - amt where id = p.id;
  elsif g.resource = 'fish' then update players set fish = fish - amt where id = p.id;
  else update players set stone = stone - amt where id = p.id; end if;
  update players set score = score + amt * 3 where id = p.id returning * into p;
  update goals set progress = progress + amt where id = g.id;
  insert into contributions values (g.id, p.id, amt)
    on conflict (goal_id, player_id) do update set amount = contributions.amount + excluded.amount;
  return _me_json(p);
end $$;

create or replace function island_state() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'players',   (select count(*) from players),
    'followers', (select coalesce(value::int,0) from settings where key = 'followers'),
    'goal', (select json_build_object('title', g.title, 'resource', g.resource, 'target', g.target,
                'progress', g.progress, 'ends_at', g.ends_at,
                'top', (select coalesce(json_agg(t), '[]'::json) from (
                   select pl.username, c.amount from contributions c join players pl on pl.id = c.player_id
                   where c.goal_id = g.id order by c.amount desc limit 3) t))
             from goals g where g.active order by g.id desc limit 1),
    'leaders', (select coalesce(json_agg(t), '[]'::json) from (
       select username, score, hut_level from players order by score desc, created_at limit 10) t));
$$;

-- Only the game functions are callable from the website.
revoke execute on function _player(uuid)      from public, anon, authenticated;
revoke execute on function _me_json(players)  from public, anon, authenticated;
grant execute on function join_island(text,text,text,jsonb), me(uuid), set_look(uuid,jsonb), do_task(uuid,text),
  upgrade_hut(uuid), redeem(uuid,text), contribute(uuid,int), island_state() to anon, authenticated;
