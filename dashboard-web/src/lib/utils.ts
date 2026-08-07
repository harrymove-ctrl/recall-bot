// vendored verbatim from https://beui.dev/r/morphing-tabs (lib/utils.ts)
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
