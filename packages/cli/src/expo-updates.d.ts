// Typecheck-only stand-in for the subset of expo-updates (SDK 52+) that flare-ota/expo uses.
// Apps get the real types from their own expo-updates install.
declare module "expo-updates" {
  export const channel: string | null;
  export function setUpdateRequestHeadersOverride(headers: Record<string, string> | null): void;
  export function fetchUpdateAsync(): Promise<{ isNew: boolean }>;
  export function reloadAsync(): Promise<void>;
  export function setExtraParamAsync(key: string, value: string | null | undefined): Promise<void>;
}
