// getenv() as the C hook calls it: the value's bytes, null if unset.
import { type Bytes, utf8Bytes } from "./bytes.js";

export function getenv(name: string): Bytes | null {
  const v = process.env[name];
  return v === undefined ? null : utf8Bytes(v);
}
