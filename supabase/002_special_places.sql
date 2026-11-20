-- Update 2: special places (cave 500, volcano 1000, shipwreck 2500 followers).
-- Paste into Supabase → SQL Editor → Run.

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

grant execute on function do_task(uuid,text) to anon, authenticated;
