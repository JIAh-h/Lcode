export function slugify(input) {
  return input.toLowerCase().replace(/\s+/g, '-')
}
