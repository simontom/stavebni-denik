// Test stub for the `server-only` package.
//
// The real package throws when imported outside a React Server Component
// bundle. Under Vitest (plain Node) we alias `server-only` to this empty
// module (see vitest.config.ts) so that server modules guarded by
// `import "server-only"` can still be unit-tested.
export {};
