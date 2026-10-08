---
name: Electric Slush & Berry Punch
colors:
  surface: '#fff7f9'
  surface-dim: '#e7d5e0'
  surface-bright: '#fff7f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#ffeff8'
  surface-container: '#fbe9f3'
  surface-container-high: '#f5e3ee'
  surface-container-highest: '#efdee8'
  on-surface: '#221920'
  on-surface-variant: '#5b3f47'
  inverse-surface: '#382d35'
  inverse-on-surface: '#feecf6'
  outline: '#8f6f77'
  outline-variant: '#e3bdc6'
  surface-tint: '#ba0061'
  primary: '#b90061'
  on-primary: '#ffffff'
  primary-container: '#e6007a'
  on-primary-container: '#ffffff'
  inverse-primary: '#ffb1c7'
  secondary: '#006493'
  on-secondary: '#ffffff'
  secondary-container: '#00affe'
  on-secondary-container: '#003f5f'
  tertiary: '#7e5600'
  on-tertiary: '#ffffff'
  tertiary-container: '#9e6d00'
  on-tertiary-container: '#ffffff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffd9e2'
  primary-fixed-dim: '#ffb1c7'
  on-primary-fixed: '#3e001d'
  on-primary-fixed-variant: '#8e0049'
  secondary-fixed: '#cae6ff'
  secondary-fixed-dim: '#8dcdff'
  on-secondary-fixed: '#001e30'
  on-secondary-fixed-variant: '#004b70'
  tertiary-fixed: '#ffdeac'
  tertiary-fixed-dim: '#ffba38'
  on-tertiary-fixed: '#281900'
  on-tertiary-fixed-variant: '#604100'
  background: '#fff7f9'
  on-background: '#221920'
  surface-variant: '#efdee8'
typography:
  display-lg:
    fontFamily: Outfit
    fontSize: 56px
    fontWeight: '900'
    lineHeight: 64px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Outfit
    fontSize: 38px
    fontWeight: '900'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Outfit
    fontSize: 36px
    fontWeight: '800'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Outfit
    fontSize: 28px
    fontWeight: '800'
    lineHeight: 34px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Outfit
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Outfit
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 26px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 15px
    fontWeight: '700'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 13px
    fontWeight: '700'
    lineHeight: 18px
    letterSpacing: 0.03em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 11px
    fontWeight: '800'
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.25rem
---

## Brand & Style

This design system translates the electric, ice-cold, sensory explosion of modern dessert and beverage culture into a digital interface. Centered on punchy refreshment, the brand aesthetic blends tactile pop art, neon cafe signage, and high-saturation fruit palettes. The interface is tailored for high-energy cafe ordering, instant table-side mobile checkouts, and vibrant food-and-drink browsing.

The design movement is **High-Contrast Pop & Tactile Neomorphism**:
- Visual drama driven by radiant magenta, ice crystal highlights, and dynamic fruit flavor tags (Mango, Blue Lagoon, Kiwi, Jamun).
- High-touch, friendly surfaces using light blush backdrops that ensure neon tones leap forward without fatiguing users.
- A celebratory tone with micro-copy accents, badge stickers, pill-shaped tags, and squishy interactive elements that feel thirst-quenching, appetizing, and undeniably social-media ready.

## Colors

The palette directly reflects chilled slushies, ripe summer fruits, and neon acrylic cafe signage:

- **Primary (`#E6007A`)**: Vibrant Magenta / Hot Pink. Used for primary calls to action, brand highlights, floating cart bubbles, active tab underlines, and heroic marketing badges.
- **Secondary (`#00B0FF`)**: Blue Lagoon Ice. Conveys chilled freshness, used for temperature indicators, cooling badges, ice-level pickers, and high-refreshment visual tags.
- **Tertiary (`#FFB300`)**: Mango Mania Gold. Expresses warmth, energy, dietary tags (e.g., bestsellers, limited editions), and five-star rating highlights.
- **Neutral Dark (`#1A1118`)**: Deep Midnight Berry. High-contrast typography base that keeps text crisp and legible over saturated accents without the harshness of pitch black.
- **Neutral Light & Surface (`#FFF5F8` to `#FFFFFF`)**: Light strawberry milk tint for foundational canvas layers, graduating to stark white `#FFFFFF` for primary cards and floating sheets.
- **Flavour Accents**:
  - Strawberry Splash: `#FF1744`
  - Kiwi Kick: `#64DD17`
  - Jamun Twist: `#7B1FA2`

Use colored drop shadows tinted with the primary hue (e.g., `rgba(230, 0, 122, 0.25)`) instead of standard desaturated blacks to maintain the glowing, neon-lit atmosphere.

## Typography

The typographic hierarchy pairs the geometric punch of **Outfit** for headlines with the friendly, ergonomic clarity of **Plus Jakarta Sans** for menus, dietary tags, ingredient details, and interactive inputs.

- **Hero Headlines & Displays**: Uppercase and title-case styling in `Outfit 800/900` evokes bold festival posters and neon marquee boards. Tight tracking (`-0.02em` to `-0.03em`) gives words a punchy, cohesive lockup.
- **Accents & Badges**: Distinct contextual microcopy (such as *“Real Flavours • Real Refreshment”* or *“Sip. Smile. Repeat.”*) should be rendered in angled pill badges or brush-styled ribbon tags using semi-expanded uppercase labels (`label-md` or `label-sm`).
- **Body & Numerical Values**: Maintained in `Plus Jakarta Sans` with comfortable line-heights to guarantee zero eye fatigue when scanning dense cafe menus or custom ingredient lists under bright ambient light.

## Layout & Spacing

The layout is built on a responsive mobile-first grid optimized for single-handed cafe mobile ordering, self-service kiosks, and tablet POS systems:

- **Mobile Viewport (<640px)**: 4-column fluid grid with `margin: 1.25rem` and `gutter: 1rem`. Cards and interactive lists favor high horizontal edge proximity while preserving thumb-friendly reach zones.
- **Tablet Viewport (640px - 1024px)**: 8-column layout with `margin: 2rem` and `gutter: 1.25rem`. Item grids split cleanly into 2-column or 3-column product cards.
- **Desktop & Kiosk (>1024px)**: 12-column layout maxed out at `1280px` content container, centered with responsive horizontal margins.

Spacing tokens provide airy padding around rich food photography, preventing fruit splashes, icy cups, and typography from feeling cramped.

## Elevation & Depth

Visual depth is achieved through **Vibrant Ambient Shadows & Frosted Tonal Surfaces**:

1. **Level 0 (Base Canvas)**: Soft tinted blush `#FFF5F8` background that absorbs harsh screen glare.
2. **Level 1 (Cards & Product Tiles)**: Crisp `#FFFFFF` surfaces layered with a diffused, color-cast shadow: `0 8px 24px -4px rgba(230, 0, 122, 0.08), 0 2px 6px -1px rgba(26, 17, 24, 0.04)`.
3. **Level 2 (Floating Action Trays & Bottom Sheets)**: Crisp white surfaces with an accented neon rim (`border: 1.5px solid rgba(230, 0, 122, 0.15)`) and amplified elevation: `0 16px 36px -6px rgba(230, 0, 122, 0.16)`.
4. **Level 3 (Modals, Overlays, and Flavor Popups)**: Backdrops use a chilled blur (`backdrop-filter: blur(12px) rgba(26, 17, 24, 0.4)`) paired with floating cards featuring an elevated colored glow: `0 24px 48px -8px rgba(230, 0, 122, 0.28)`.

## Shapes

The design system embraces ultra-generous, friendly geometry with a roundedness factor of `3` (Pill-shaped).

- **Cards & Hero Modules**: Styled with large organic corners (`rounded-3xl` / `24px - 32px`), mimicking smooth river pebbles, rounded tumbler cups, and squishy confection packaging.
- **Chips, Badges, and Action Buttons**: Fully rounded pill forms (`rounded-full` / `9999px`) that invite immediate tap interactions.
- **Micro-accents**: Ribbons, stickers, and price roundels employ subtle rotation tilts (`-2deg` to `+3deg`) and pill-shaped silhouettes to echo physical merchandise stickers and cafe promotional cutouts.

## Components

### Buttons
- **Primary Action**: Solid Hot Pink (`#E6007A`) pill button with bold white text, subtle hover lift (`translateY(-2px)`), and a signature glow shadow (`0 10px 20px -5px rgba(230, 0, 122, 0.4)`).
- **Secondary Action**: Frosted white or translucent blush pill button with a crisp 2px border in `#E6007A` and high-contrast text.
- **Floating Cart / Order Bar**: Pill container anchored to the mobile viewport base, styled with a high-contrast Hot Pink fill and contrasting white label details.

### Chips & Flavor Badges
- Dynamic flavor pill chips:
  - *Blue Lagoon*: Cyan background `#E0F7FA` with `#00B0FF` border and `#007BB2` text.
  - *Mango Mania*: Amber background `#FFF8E1` with `#FFB300` border and `#C47D00` text.
  - *Strawberry Splash*: Soft rose `#FFEBEE` with `#FF1744` border and `#C62828` text.
  - *Kiwi Kick*: Crisp lime `#F1F8E9` with `#64DD17` border and `#33691E` text.
  - *Jamun Twist*: Violet mist `#F3E5F5` with `#7B1FA2` border and `#4A148C` text.
- State: Selected flavor chips switch to solid fills with white typography and a bouncy active scale transformation (`scale(1.05)`).

### Cards
- **Product Tiles**: Crisp white cards with `rounded-3xl` geometry. Images sit at the top with a subtle circular pastel gradient glow behind the beverage/pizza render. Bottom zone includes bold title (`headline-sm`), punchy price tag in Hot Pink, and a circular plus (`+`) quick-add button.
- **Banner / Feature Cards**: Saturated gradient backgrounds (Hot Pink to Strawberry Red or Lagoon Blue) overlaid with white typography and dynamic sticker badges.

### Input Fields
- Generously rounded (`rounded-2xl`) pill-adjacent inputs.
- `#FFFFFF` background with a gentle border (`#F0D8E4`).
- Focus state activates an illuminated `#E6007A` border with a soft `0 0 0 4px rgba(230, 0, 122, 0.15)` focus ring.

### Checkboxes, Radio & Toggles
- Custom fruit-colored radio buttons for beverage customization (e.g., Ice Level, Sugar %, Extra Popping Boba). Active items display an outer ring in `#E6007A` with a centered juicy pink bullet.
- Toggles feature pill housings with smooth spring-loaded circular knobs that pop with a primary gradient when turned on.

### Cafe-Specific Components
- **Topping Selector Wheel**: Segmented horizontal pill scroll allowing rapid single-tap selection of drizzles, fruit pops, and whipped layers.
- **Sweetness & Chill Slider**: Tactile stepped slider using fruit slice and snowflake icons at each threshold marker.