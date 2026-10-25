/** Replace known `{name}` placeholders and preserve placeholders without a supplied value. */
export function fillTemplate(template: string, vars: Readonly<Record<string, string | number | null | undefined>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
