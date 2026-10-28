/**
 * The message of a thrown value. Anything can be thrown or passed to a
 * rejection, and `String()` of a plain object is "[object Object]", so a plain
 * object gives its `message` or its JSON (#121). Takes `unknown` on purpose: a
 * caught value narrowed by a check such as `!== undefined` is typed `{}`,
 * which hides that it can be anything.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const { message } = err as { message?: unknown };
    if (typeof message === "string" && message) return message;
    try {
      const json = JSON.stringify(err);
      if (json !== undefined) return json;
    } catch {
      // Cyclic or holding a BigInt: String() below is all that is left.
    }
  }
  return String(err);
}
