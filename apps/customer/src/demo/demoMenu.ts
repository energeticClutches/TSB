/**
 * DEMO MENU (mirrors supabase/seed/demo_menu.sql). Used only when VITE_DEMO=true.
 * Photos are crops of the owner's poster until real product photos arrive.
 */
import type { MenuModifierGroup, MenuProduct, MenuSnapshot } from '@slush/core';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const ice: MenuModifierGroup = {
  id: id(901),
  name: 'Ice level',
  kind: 'free_option',
  min: 1,
  max: 1,
  options: [
    { id: id(911), name: 'Light ice (juicier)', price_paise: 0, default: false, sold_out: false },
    { id: id(912), name: 'Standard freeze', price_paise: 0, default: true, sold_out: false },
    { id: id(913), name: 'Extra frosty', price_paise: 0, default: false, sold_out: false },
  ],
};
const sweet: MenuModifierGroup = {
  id: id(902),
  name: 'Sweetness',
  kind: 'free_option',
  min: 1,
  max: 1,
  options: [
    { id: id(921), name: '50% sweet', price_paise: 0, default: false, sold_out: false },
    { id: id(922), name: '100% balanced', price_paise: 0, default: true, sold_out: false },
    { id: id(923), name: 'Extra sweet', price_paise: 0, default: false, sold_out: false },
  ],
};
const toppings: MenuModifierGroup = {
  id: id(903),
  name: 'Toppings',
  kind: 'paid_addon',
  min: 0,
  max: 3,
  options: [
    { id: id(931), name: 'Popping boba', price_paise: 3000, default: false, sold_out: false },
    { id: id(932), name: 'Fruit jelly', price_paise: 2000, default: false, sold_out: false },
    { id: id(933), name: 'Whipped cream', price_paise: 2500, default: false, sold_out: false },
  ],
};
const cheese: MenuModifierGroup = {
  id: id(904),
  name: 'Extra cheese',
  kind: 'paid_addon',
  min: 0,
  max: 1,
  options: [{ id: id(941), name: 'Extra cheese', price_paise: 4000, default: false, sold_out: false }],
};

const C = { slush: id(1), shake: id(2), pizza: id(3), mock: id(4) };

const slush = (n: number, name: string, description: string, accent: string, price: number, image: string): MenuProduct => ({
  id: id(100 + n),
  category_id: C.slush,
  kind: 'item',
  name,
  description,
  image,
  accent,
  featured: true,
  sold_out: false,
  prep_minutes: 4,
  windows: [],
  variants: [
    { id: id(200 + n * 2), name: 'Regular 350 ml', price_paise: price, default: true },
    { id: id(201 + n * 2), name: 'Mega 500 ml', price_paise: price + 4000, default: false },
  ],
  modifier_groups: [ice, sweet, toppings],
  combo: [],
});

const simple = (n: number, category: string, name: string, description: string, prep: number, sizes: [string, number][], groups: MenuModifierGroup[] = []): MenuProduct => ({
  id: id(100 + n),
  category_id: category,
  kind: 'item',
  name,
  description,
  image: null,
  accent: null,
  featured: false,
  sold_out: false,
  prep_minutes: prep,
  windows: [],
  variants: sizes.map(([vname, price], i) => ({ id: id(300 + n * 3 + i), name: vname, price_paise: price, default: i === 0 })),
  modifier_groups: groups,
  combo: [],
});

export const demoMenu: MenuSnapshot = {
  version: 1,
  branch: {
    slug: 'bahadurgarh-s6',
    name: 'The Slush Bar',
    address: 'Shop No. 140, Sector-6 Market, Bahadurgarh, Haryana 124507',
    phone: null,
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '11:00', closes: '23:00' })),
    closures: [],
    last_order_buffer_min: 15,
    // On in the demo so the delivery flow can be tried (open the site without a QR code).
    delivery_enabled: true,
  },
  promotions: [
    {
      id: id(801),
      kind: 'happy_hour',
      label: 'Happy hour: 20% off slushes, 3–6 PM',
      discount_type: 'percent',
      value: 2000,
      max_discount_paise: null,
      min_order_paise: null,
      windows: [{ days_mask: 127, start: '15:00', end: '18:00' }],
      category_ids: [id(1)],
      product_ids: [],
    },
  ],
  categories: [
    { id: C.slush, name: 'Slushes', windows: [] },
    { id: C.shake, name: 'Shakes', windows: [] },
    { id: C.pizza, name: 'Pizzas', windows: [{ days_mask: 127, start: '16:00', end: '23:00' }] },
    { id: C.mock, name: 'Mocktails', windows: [] },
  ],
  products: [
    slush(1, 'Blue Lagoon', 'Tangy blue curaçao citrus blast with iced popping pearls.', '#00C0F3', 12900, '/img/blue-lagoon.webp'),
    slush(2, 'Mango Mania', 'Ratnagiri Alphonso mango crushed into silky chilled ice.', '#FFB300', 13900, '/img/mango-mania.webp'),
    slush(3, 'Strawberry Splash', 'Handpicked hill strawberries with fresh lime.', '#FF1744', 14900, '/img/strawberry-splash.webp'),
    slush(4, 'Kiwi Kick', 'Crisp emerald kiwi puree with crushed ice.', '#64DD17', 13900, '/img/kiwi-kick.webp'),
    slush(5, 'Jamun Twist', 'Traditional sweet-tangy Indian black plum with rock salt.', '#7B1FA2', 15900, '/img/jamun-twist.webp'),
    simple(10, C.shake, 'Belgian Choco Thick Shake', 'Velvety dark chocolate gelato blended with creamy whole milk.', 5, [['Regular', 18900]], [toppings]),
    simple(20, C.pizza, 'Cheesy Farmhouse Pizza', 'Stone-fired crust, molten mozzarella, bell peppers, sweet corn.', 12, [['8 inch', 24900], ['10 inch', 32900]], [cheese]),
    simple(21, C.pizza, 'Paneer Tikka Fusion Pizza', 'Smoked tandoori paneer, red paprika, spiced makhani sauce.', 12, [['8 inch', 27900], ['10 inch', 35900]], [cheese]),
    simple(30, C.mock, 'Mint Lime Virgin Mojito', 'Crushed garden mint, key lime and sparkling soda.', 3, [['Regular', 11900]]),
  ],
};
