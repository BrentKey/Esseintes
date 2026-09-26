/** Top-level departments and the categories within them, in menu order. */
export const DEPARTMENTS: { name: string; categories: string[] }[] = [
  {
    name: 'Clothing',
    categories: [
      'Coats & Jackets', 'Suits & Blazers', 'Shirts', 'Polos', 'T-Shirts & Tops', 'Knitwear', 'Sweats & Hoodies',
      'Trousers', 'Jeans', 'Shorts', 'Swimwear', 'Underwear & Socks', 'Loungewear', 'Dresses & Skirts'
    ]
  },
  { name: 'Shoes', categories: ['Shoes'] },
  { name: 'Bags', categories: ['Bags'] },
  {
    name: 'Accessories',
    categories: [
      'Hats & Caps', 'Sunglasses', 'Glasses', 'Belts', 'Wallets & Leather Goods', 'Scarves & Gloves',
      'Ties & Pocket Squares', 'Jewellery', 'Watches', 'Other Accessories'
    ]
  },
  { name: 'Lifestyle', categories: ['Grooming', 'Home & Lifestyle', 'Other'] }
]

export const WOMEN_ONLY_CATEGORIES = ['Dresses & Skirts']

export function departmentOf(category: string): string {
  return DEPARTMENTS.find((d) => d.categories.includes(category))?.name ?? 'Lifestyle'
}
