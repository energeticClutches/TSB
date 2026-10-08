-- DEMO MENU for development and staging only. Never load into production.
-- Prices and items come from the Stitch mock-ups/poster; the owner's real menu card replaces this.
do $$
declare
  b uuid := (select id from public.branches where slug = 'bahadurgarh-s6');
  c_slush uuid; c_shake uuid; c_pizza uuid; c_mock uuid;
  g_ice uuid; g_sweet uuid; g_top uuid; g_crust uuid;
  p uuid;
  r record;
begin
  insert into public.categories (branch_id, name, sort_order) values (b, 'Slushes', 1) returning id into c_slush;
  insert into public.categories (branch_id, name, sort_order) values (b, 'Shakes', 2) returning id into c_shake;
  insert into public.categories (branch_id, name, sort_order) values (b, 'Pizzas', 3) returning id into c_pizza;
  insert into public.categories (branch_id, name, sort_order) values (b, 'Mocktails', 4) returning id into c_mock;
  insert into public.availability_windows (category_id, start_time, end_time) values (c_pizza, '16:00', '23:00');

  insert into public.modifier_groups (branch_id, name, kind, min_select, max_select) values (b, 'Ice level', 'free_option', 1, 1) returning id into g_ice;
  insert into public.modifier_options (group_id, name, is_default, sort_order) values
    (g_ice, 'Light ice (juicier)', false, 1), (g_ice, 'Standard freeze', true, 2), (g_ice, 'Extra frosty', false, 3);
  insert into public.modifier_groups (branch_id, name, kind, min_select, max_select) values (b, 'Sweetness', 'free_option', 1, 1) returning id into g_sweet;
  insert into public.modifier_options (group_id, name, is_default, sort_order) values
    (g_sweet, '50% sweet', false, 1), (g_sweet, '100% balanced', true, 2), (g_sweet, 'Extra sweet', false, 3);
  insert into public.modifier_groups (branch_id, name, kind, min_select, max_select) values (b, 'Toppings', 'paid_addon', 0, 3) returning id into g_top;
  insert into public.modifier_options (group_id, name, price_paise, sort_order) values
    (g_top, 'Popping boba', 3000, 1), (g_top, 'Fruit jelly', 2000, 2), (g_top, 'Whipped cream', 2500, 3);
  insert into public.modifier_groups (branch_id, name, kind, min_select, max_select) values (b, 'Extra cheese', 'paid_addon', 0, 1) returning id into g_crust;
  insert into public.modifier_options (group_id, name, price_paise, sort_order) values (g_crust, 'Extra cheese', 4000, 1);

  for r in select * from (values
      ('Blue Lagoon',       'Tangy blue curaçao citrus blast with iced popping pearls.', '#00C0F3', 12900, 1, true),
      ('Mango Mania',       'Ratnagiri Alphonso mango crushed into silky chilled ice.',   '#FFB300', 13900, 2, true),
      ('Strawberry Splash', 'Handpicked hill strawberries with fresh lime.',              '#FF1744', 14900, 3, true),
      ('Kiwi Kick',         'Crisp emerald kiwi puree with crushed ice.',                 '#64DD17', 13900, 4, true),
      ('Jamun Twist',       'Traditional sweet-tangy Indian black plum with rock salt.',  '#7B1FA2', 15900, 5, true)
    ) as t(name, descr, accent, price, ord, featured)
  loop
    insert into public.products (branch_id, category_id, name, description, accent_color, prep_minutes, is_featured, sort_order)
    values (b, c_slush, r.name, r.descr, r.accent, 4, r.featured, r.ord) returning id into p;
    insert into public.product_variants (product_id, name, price_paise, is_default, sort_order) values
      (p, 'Regular 350 ml', r.price, true, 1), (p, 'Mega 500 ml', r.price + 4000, false, 2);
    insert into public.product_modifier_groups (product_id, group_id, sort_order) values (p, g_ice, 1), (p, g_sweet, 2), (p, g_top, 3);
  end loop;

  insert into public.products (branch_id, category_id, name, description, prep_minutes, sort_order)
  values (b, c_shake, 'Belgian Choco Thick Shake', 'Velvety dark chocolate gelato blended with creamy whole milk.', 5, 1) returning id into p;
  insert into public.product_variants (product_id, name, price_paise, is_default, sort_order) values (p, 'Regular', 18900, true, 1);
  insert into public.product_modifier_groups (product_id, group_id) values (p, g_top);

  insert into public.products (branch_id, category_id, name, description, prep_minutes, sort_order)
  values (b, c_pizza, 'Cheesy Farmhouse Pizza', 'Stone-fired crust, molten mozzarella, bell peppers, sweet corn.', 12, 1) returning id into p;
  insert into public.product_variants (product_id, name, price_paise, is_default, sort_order) values
    (p, '8 inch', 24900, true, 1), (p, '10 inch', 32900, false, 2);
  insert into public.product_modifier_groups (product_id, group_id) values (p, g_crust);

  insert into public.products (branch_id, category_id, name, description, prep_minutes, sort_order)
  values (b, c_pizza, 'Paneer Tikka Fusion Pizza', 'Smoked tandoori paneer, red paprika, spiced makhani sauce.', 12, 2) returning id into p;
  insert into public.product_variants (product_id, name, price_paise, is_default, sort_order) values
    (p, '8 inch', 27900, true, 1), (p, '10 inch', 35900, false, 2);
  insert into public.product_modifier_groups (product_id, group_id) values (p, g_crust);

  insert into public.products (branch_id, category_id, name, description, prep_minutes, sort_order)
  values (b, c_mock, 'Mint Lime Virgin Mojito', 'Crushed garden mint, freshly squeezed key lime and sparkling soda.', 3, 1) returning id into p;
  insert into public.product_variants (product_id, name, price_paise, is_default, sort_order) values (p, 'Regular', 11900, true, 1);

  perform app.bump_menu_version(b);
end $$;
