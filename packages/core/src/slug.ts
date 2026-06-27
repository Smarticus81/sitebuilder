export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** e.g. "Joe's Barbershop" → joes-barbershop.demo.storefrontstudio.com */
export function subdomainFor(name: string, baseDomain: string): string {
  return `${slugify(name)}.${baseDomain}`;
}
