/* Minimal class merger (shadcn cn without Tailwind: no twMerge needed
   in a project that does not use Tailwind utility classes). */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
