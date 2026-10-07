import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertLocalDatabase } from "./local-db-guard";

describe("assertLocalDatabase", () => {
  const local = [
    "postgresql://denik@localhost:5432/stavebni_denik",
    "postgres://localhost/stavebni_denik",
    "postgresql://denik@127.0.0.1:5432/stavebni_denik",
    "postgresql://denik@[::1]:5432/stavebni_denik",
    "postgresql://denik@LOCALHOST:5432/stavebni_denik",
  ];
  for (const url of local) {
    test(`accepts ${url}`, () => {
      assert.doesNotThrow(() => assertLocalDatabase(url));
    });
  }

  const remote = [
    "postgresql://denik@db.example.com:5432/stavebni_denik",
    "postgresql://denik@10.0.0.5:5432/stavebni_denik",
    "postgresql://denik@0.0.0.0:5432/stavebni_denik",
    "postgresql://denik@localhost.example.com:5432/stavebni_denik",
    "postgresql://denik@127.0.0.1.example.com:5432/stavebni_denik",
    // "localhost" here is the user name, the host is db.example.com
    "postgresql://localhost@db.example.com:5432/stavebni_denik",
    // unix-socket style URL without a host
    "postgresql:///stavebni_denik?host=/var/run/postgresql",
  ];
  for (const url of remote) {
    test(`refuses ${url}`, () => {
      assert.throws(() => assertLocalDatabase(url), /non-local database host/);
    });
  }

  test("refuses a value that is not a URL", () => {
    assert.throws(() => assertLocalDatabase("not a url"), /not a valid connection URL/);
  });

  test("never puts the user name into the error message", () => {
    assert.throws(
      () => assertLocalDatabase("postgresql://someuser@db.example.com/stavebni_denik"),
      (err: Error) => err.message.includes("db.example.com") && !err.message.includes("someuser"),
    );
  });
});
