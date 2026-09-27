import assert from "node:assert/strict";
import test from "node:test";
import { seal, unseal } from "./secrets.ts";

const key = "0".repeat(64);

test("rotating tokens can be stored encrypted and recovered", async () => {
  const first = await seal("refresh-token", key);
  const second = await seal("refresh-token", key);
  assert.notEqual(first, "refresh-token");
  assert.notEqual(first, second);
  assert.equal(await unseal(first, key), "refresh-token");
  await assert.rejects(unseal(first, "1".repeat(64)));
});
