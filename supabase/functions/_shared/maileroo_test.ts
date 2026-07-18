import { parseEmailAddress } from "./maileroo.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("parses a named EMAIL_FROM address for Maileroo", () => {
  assertEquals(parseEmailAddress("Backyard Pickle <bookings@example.com>"), {
    address: "bookings@example.com",
    display_name: "Backyard Pickle",
  });
});

Deno.test("accepts a bare email address", () => {
  assertEquals(parseEmailAddress("bookings@example.com"), {
    address: "bookings@example.com",
  });
});

Deno.test("rejects an invalid sender", () => {
  let failed = false;
  try {
    parseEmailAddress("Backyard Pickle");
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Invalid sender should be rejected");
});
