// Fixed fake catalogues. Prices are cents. Nothing here refers to a real seller's stock.

export type Product = {
  readonly id: string
  readonly title: string
  readonly brand: string
  readonly category: string
  readonly price: number
  readonly rating: number
  readonly reviews: number
  readonly keywords: string
  readonly sponsored?: boolean
  readonly colors?: readonly string[]
  readonly sizes?: readonly string[]
  /** Variant keys (`color|size`, either part may be empty) that are out of stock. */
  readonly outOfStock?: readonly string[]
  readonly bullets: readonly string[]
}

export const products: readonly Product[] = [
  { id: "ankr-20w", title: "Ankr 20W Fast Charger, USB-C Wall Plug", brand: "Ankr", category: "electronics", price: 1199, rating: 3.9, reviews: 412, keywords: "charger usb-c 20w wall plug anker", sponsored: true, colors: ["Black", "White"], bullets: ["20W output", "Foldable prongs"] },
  { id: "anker-nano-20w", title: "Anker Nano 20W USB-C Charger", brand: "Anker", category: "electronics", price: 1599, rating: 4.7, reviews: 18233, keywords: "charger usb-c 20w nano wall iphone", colors: ["Black", "White", "Lavender"], bullets: ["Compact 20W PD charger", "Works with iPhone and Pixel"] },
  { id: "anker-nano-30w", title: "Anker Nano 30W USB-C Charger", brand: "Anker", category: "electronics", price: 2199, rating: 4.8, reviews: 6120, keywords: "charger usb-c 30w nano wall", colors: ["Black", "White"], bullets: ["30W GaN charger"] },
  { id: "belkin-25w", title: "Belkin BoostCharge 25W USB-C Charger", brand: "Belkin", category: "electronics", price: 1999, rating: 4.5, reviews: 3011, keywords: "charger usb-c 25w wall", colors: ["White"], bullets: ["25W PPS"] },
  { id: "cable-usbc-2m", title: "Braided USB-C to USB-C Cable, 2 m", brand: "Anker", category: "electronics", price: 999, rating: 4.6, reviews: 9800, keywords: "cable usb-c braided charger", colors: ["Black", "Grey"], bullets: ["60W", "Braided nylon"] },
  { id: "earbuds-p3", title: "Soundcore P3 Wireless Earbuds", brand: "Soundcore", category: "electronics", price: 4999, rating: 4.4, reviews: 7710, keywords: "earbuds wireless headphones bluetooth", colors: ["Black", "Blue"], bullets: ["Noise cancelling", "8 h battery"] },
  { id: "skillet-hearth", title: "Hearth Pre-Seasoned Cast-Iron Skillet", brand: "Hearth", category: "kitchen", price: 2499, rating: 4.8, reviews: 22104, keywords: "skillet cast iron pan frying cookware", sizes: ["8-inch", "10-inch", "12-inch"], outOfStock: ["|12-inch"], bullets: ["Pre-seasoned", "Oven safe to 500°F"] },
  { id: "skillet-ironclad", title: "Ironclad Cast-Iron Skillet with Lid", brand: "Ironclad", category: "kitchen", price: 3999, rating: 4.3, reviews: 905, keywords: "skillet cast iron pan lid cookware", sponsored: true, sizes: ["10-inch", "12-inch"], bullets: ["Includes glass lid"] },
  { id: "kettle-volta", title: "Volta Electric Kettle, 1.7 L", brand: "Volta", category: "kitchen", price: 3499, rating: 4.6, reviews: 5402, keywords: "kettle electric tea water", colors: ["Steel", "Matte Black"], bullets: ["Boils in 4 minutes", "Auto shut-off"] },
  { id: "kettle-gooseneck", title: "Pourwell Gooseneck Kettle", brand: "Pourwell", category: "kitchen", price: 5999, rating: 4.7, reviews: 2210, keywords: "kettle gooseneck coffee pour over", colors: ["Black"], bullets: ["Temperature hold"] },
  { id: "knife-chef", title: "Kiri 8-inch Chef's Knife", brand: "Kiri", category: "kitchen", price: 4599, rating: 4.7, reviews: 3300, keywords: "knife chef kitchen", bullets: ["High-carbon steel"] },
  { id: "jacket-trailpeak", title: "TrailPeak Packable Rain Jacket", brand: "TrailPeak", category: "clothing", price: 6999, rating: 4.5, reviews: 4120, keywords: "rain jacket waterproof coat outdoor", colors: ["Black", "Navy", "Olive"], sizes: ["S", "M", "L", "XL"], outOfStock: ["Olive|M", "Navy|XL"], bullets: ["Waterproof 10k", "Packs into its pocket"] },
  { id: "jacket-summit", title: "Summit Insulated Jacket", brand: "Summit", category: "clothing", price: 12999, rating: 4.6, reviews: 1980, keywords: "jacket insulated winter coat", colors: ["Black", "Red"], sizes: ["S", "M", "L"], bullets: ["Synthetic fill"] },
  { id: "jacket-trailpeak-kids", title: "TrailPeak Kids' Rain Jacket", brand: "TrailPeak", category: "clothing", price: 3999, rating: 4.4, reviews: 610, keywords: "rain jacket kids waterproof", colors: ["Navy", "Yellow"], sizes: ["XS", "S"], bullets: ["For ages 6-12"] },
  { id: "socks-merino", title: "Merino Hiking Socks, 3 pairs", brand: "Summit", category: "clothing", price: 2400, rating: 4.7, reviews: 8800, keywords: "socks merino hiking wool", sizes: ["M", "L"], bullets: ["Cushioned"] },
  { id: "nb-classic-ruled", title: "Fieldnote Classic Notebook, A5 Ruled", brand: "Fieldnote", category: "office", price: 1299, rating: 4.6, reviews: 1500, keywords: "notebook journal a5 ruled paper", bullets: ["192 pages"] },
  { id: "nb-pocket-3", title: "Fieldnote Pocket Notebooks, 3-pack", brand: "Fieldnote", category: "office", price: 1099, rating: 4.5, reviews: 2200, keywords: "notebook pocket memo", bullets: ["48 pages each"] },
  { id: "nb-spiral", title: "Campus Spiral Notebook, College Ruled", brand: "Campus", category: "office", price: 499, rating: 4.3, reviews: 12000, keywords: "notebook spiral college school", bullets: ["70 sheets"] },
  { id: "nb-leather", title: "Leather Journal Notebook, A5", brand: "Oxhide", category: "office", price: 2999, rating: 4.4, reviews: 870, keywords: "notebook journal leather a5", bullets: ["Refillable"] },
  { id: "nb-grid", title: "Engineer's Graph Notebook, A4 Grid", brand: "Campus", category: "office", price: 899, rating: 4.5, reviews: 640, keywords: "notebook graph grid engineering", bullets: ["5 mm grid"] },
  { id: "nb-kraft", title: "Kraft Cover Notebooks, A5 Blank, 2-pack", brand: "Oxhide", category: "office", price: 1199, rating: 4.2, reviews: 330, keywords: "notebook blank kraft a5", bullets: ["Plain pages"] },
  { id: "nb-planner", title: "Undated Weekly Planner Notebook", brand: "Fieldnote", category: "office", price: 1899, rating: 4.6, reviews: 950, keywords: "notebook planner weekly", bullets: ["Undated"] },
  { id: "nb-dot-a5", title: "Fieldnote Dot-Grid Notebook, A5", brand: "Fieldnote", category: "office", price: 1499, rating: 4.8, reviews: 3120, keywords: "notebook dot grid bullet journal a5", bullets: ["Dot grid", "Lay-flat binding"] },
  { id: "nb-dot-a4", title: "Fieldnote Dot-Grid Notebook, A4", brand: "Fieldnote", category: "office", price: 1999, rating: 4.7, reviews: 640, keywords: "notebook dot grid a4", bullets: ["Dot grid", "Large format"] },
  { id: "pens-gel", title: "Gel Pens, Fine Point, 12-pack", brand: "Inkwell", category: "office", price: 899, rating: 4.6, reviews: 9100, keywords: "pens gel writing", bullets: ["0.5 mm"] },
]

export const protectionPlanCents = 499
export const shippingOptions = [
  { id: "oneday", label: "One-Day Delivery", detail: "Tomorrow", cents: 1499 },
  { id: "expedited", label: "Expedited", detail: "2-3 business days", cents: 999 },
  { id: "standard", label: "Standard (FREE)", detail: "5-7 business days", cents: 0 },
] as const
export const promoCodes: Readonly<Record<string, number>> = { SAVE10: 10 }

type OptionGroup = {
  readonly id: string
  readonly label: string
  readonly required: boolean
  /** Maximum selections; 1 renders radios. */
  readonly max: number
  readonly choices: readonly { readonly name: string; readonly cents: number }[]
}

export type MenuItem = {
  readonly id: string
  readonly name: string
  readonly cents: number
  readonly description: string
  readonly soldOut?: boolean
  readonly groups?: readonly OptionGroup[]
}

export type Restaurant = {
  readonly id: string
  readonly name: string
  readonly cuisine: string
  readonly rating: number
  readonly eta: string
  readonly fee: number
  readonly open: boolean
  readonly keywords: string
  readonly sections: readonly { readonly name: string; readonly lazy?: boolean; readonly items: readonly MenuItem[] }[]
}

const pizzaSize: OptionGroup = { id: "size", label: "Choose a size", required: true, max: 1, choices: [{ name: "Small 10\"", cents: 0 }, { name: "Medium 12\"", cents: 300 }, { name: "Large 16\"", cents: 600 }] }
const pizzaExtras: OptionGroup = { id: "extras", label: "Add toppings", required: false, max: 3, choices: [{ name: "Extra basil", cents: 100 }, { name: "Extra mozzarella", cents: 200 }, { name: "Mushrooms", cents: 150 }, { name: "Hot honey", cents: 150 }] }
const drinkSize: OptionGroup = { id: "size", label: "Size", required: true, max: 1, choices: [{ name: "Small", cents: 0 }, { name: "Medium", cents: 50 }, { name: "Large", cents: 100 }] }
const milk: OptionGroup = { id: "milk", label: "Milk", required: true, max: 1, choices: [{ name: "Whole milk", cents: 0 }, { name: "Oat milk", cents: 75 }, { name: "Almond milk", cents: 75 }] }
const thaiProtein: OptionGroup = { id: "protein", label: "Choose a protein", required: true, max: 1, choices: [{ name: "Tofu", cents: 0 }, { name: "Chicken", cents: 0 }, { name: "Shrimp", cents: 300 }] }
const spice: OptionGroup = { id: "spice", label: "Spice level", required: true, max: 1, choices: [{ name: "Mild", cents: 0 }, { name: "Medium", cents: 0 }, { name: "Thai hot", cents: 0 }] }

export const restaurants: readonly Restaurant[] = [
  {
    id: "tonys-slice", name: "Tony's Slice", cuisine: "Pizza", rating: 4.7, eta: "20-30 min", fee: 199, open: true, keywords: "pizza italian slice",
    sections: [
      { name: "Pizzas", items: [
        { id: "margherita", name: "Margherita Pizza", cents: 1400, description: "Tomato, fresh mozzarella, basil.", groups: [pizzaSize, pizzaExtras] },
        { id: "pepperoni", name: "Pepperoni Pizza", cents: 1600, description: "Cup-and-char pepperoni.", groups: [pizzaSize, pizzaExtras] },
        { id: "white", name: "White Pie", cents: 1700, description: "Ricotta, garlic, mozzarella.", soldOut: true },
      ] },
      { name: "Sides", items: [
        { id: "knots", name: "Garlic Knots (6)", cents: 600, description: "With marinara." },
        { id: "caesar", name: "Caesar Salad", cents: 900, description: "Romaine, parmesan, croutons." },
      ] },
    ],
  },
  {
    id: "bangkok-garden", name: "Bangkok Garden", cuisine: "Thai", rating: 4.9, eta: "Opens at 5:00 PM", fee: 99, open: false, keywords: "thai pad thai curry noodles",
    sections: [{ name: "Noodles", items: [{ id: "pad-thai", name: "Pad Thai", cents: 1500, description: "Rice noodles, tamarind, peanuts.", groups: [thaiProtein, spice] }] }],
  },
  {
    id: "lemongrass", name: "Lemongrass Thai Kitchen", cuisine: "Thai", rating: 4.5, eta: "25-35 min", fee: 249, open: true, keywords: "thai pad thai curry noodles",
    sections: [
      { name: "Noodles", items: [
        { id: "pad-thai", name: "Pad Thai", cents: 1450, description: "Rice noodles, egg, tamarind, peanuts.", groups: [thaiProtein, spice] },
        { id: "pad-see-ew", name: "Pad See Ew", cents: 1450, description: "Wide noodles, Chinese broccoli.", groups: [thaiProtein] },
      ] },
      { name: "Curries", items: [{ id: "green-curry", name: "Green Curry", cents: 1550, description: "Coconut, Thai basil, bamboo.", groups: [thaiProtein, spice] }] },
    ],
  },
  {
    id: "casa-verde", name: "Casa Verde Taqueria", cuisine: "Mexican", rating: 4.6, eta: "15-25 min", fee: 149, open: true, keywords: "mexican burrito tacos bowl",
    sections: [
      { name: "Tacos", items: [
        { id: "tacos-al-pastor", name: "Al Pastor Tacos (3)", cents: 1200, description: "Pineapple, onion, cilantro." },
        { id: "tacos-fish", name: "Baja Fish Tacos (3)", cents: 1350, description: "Beer-battered cod, slaw." },
      ] },
      { name: "Burritos", items: [
        { id: "burrito-chicken", name: "Chicken Burrito", cents: 1300, description: "Rice, beans, salsa, cheese.", groups: [
          { id: "rice", label: "Rice", required: true, max: 1, choices: [{ name: "White rice", cents: 0 }, { name: "Brown rice", cents: 0 }, { name: "No rice", cents: 0 }] },
        ] },
      ] },
      { name: "Sides & Drinks", items: [
        { id: "chips", name: "Chips & Guacamole", cents: 700, description: "Made to order." },
        { id: "horchata", name: "Horchata", cents: 450, description: "Cinnamon rice drink." },
      ] },
      { name: "Bowls", lazy: true, items: [
        { id: "bowl-veggie", name: "Veggie Bowl", cents: 1200, description: "Fajita vegetables, guacamole." },
        { id: "bowl-chicken", name: "Chicken Burrito Bowl", cents: 1400, description: "Grilled chicken over rice and beans.", groups: [
          { id: "rice", label: "Rice", required: true, max: 1, choices: [{ name: "White rice", cents: 0 }, { name: "Brown rice", cents: 0 }, { name: "No rice", cents: 0 }] },
          { id: "beans", label: "Beans", required: true, max: 1, choices: [{ name: "Black beans", cents: 0 }, { name: "Pinto beans", cents: 0 }, { name: "No beans", cents: 0 }] },
          { id: "salsa", label: "Salsa", required: true, max: 1, choices: [{ name: "Mild tomato salsa", cents: 0 }, { name: "Medium tomatillo salsa", cents: 0 }, { name: "Hot red salsa", cents: 0 }] },
          { id: "extras", label: "Extras", required: false, max: 2, choices: [{ name: "Guacamole", cents: 250 }, { name: "Sour cream", cents: 75 }, { name: "Queso", cents: 150 }] },
        ] },
      ] },
    ],
  },
  {
    id: "bean-there", name: "Bean There Coffee", cuisine: "Coffee", rating: 4.8, eta: "10-15 min", fee: 99, open: true, keywords: "coffee latte espresso cafe breakfast",
    sections: [
      { name: "Espresso", items: [
        { id: "latte", name: "Latte", cents: 475, description: "Double shot, steamed milk.", groups: [drinkSize, milk] },
        { id: "iced-latte", name: "Iced Latte", cents: 525, description: "Double shot over ice.", groups: [drinkSize, milk] },
        { id: "cold-brew", name: "Cold Brew", cents: 450, description: "Steeped 18 hours.", groups: [drinkSize] },
      ] },
      { name: "Bakery", items: [
        { id: "croissant", name: "Butter Croissant", cents: 400, description: "Baked this morning." },
        { id: "muffin", name: "Blueberry Muffin", cents: 375, description: "Streusel top.", soldOut: true },
      ] },
    ],
  },
  {
    id: "sakura", name: "Sakura Sushi", cuisine: "Japanese", rating: 4.6, eta: "30-40 min", fee: 299, open: true, keywords: "sushi japanese rolls ramen",
    sections: [
      { name: "Rolls", items: [
        { id: "spicy-tuna", name: "Spicy Tuna Roll", cents: 900, description: "Tuna, spicy mayo, cucumber." },
        { id: "california", name: "California Roll", cents: 800, description: "Crab, avocado, cucumber." },
        { id: "dragon", name: "Dragon Roll", cents: 1500, description: "Eel, avocado, tempura shrimp." },
      ] },
    ],
  },
  {
    id: "green-leaf", name: "Green Leaf Salads", cuisine: "Healthy", rating: 4.4, eta: "15-25 min", fee: 199, open: true, keywords: "salad healthy bowl vegan",
    sections: [{ name: "Salads", items: [{ id: "cobb", name: "Cobb Salad", cents: 1300, description: "Chicken, egg, bacon, blue cheese." }] }],
  },
]

export const membershipCents = 999
