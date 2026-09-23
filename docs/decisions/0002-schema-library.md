# 0002: Command schema library

Status: Accepted.

## Context

CLI and SDK commands share validation and need inferred TypeScript input/output
types, a JSON wire representation, and JSON Schema metadata for CLI tooling.

## Options

- Build custom validation and metadata generation.
- Adopt Zod v4 for schemas, type inference, and JSON Schema generation.

## Decision

Use `npm:zod@^4`, declared as `zod` in the root `deno.json` imports. Command
schemas will define inputs and outputs with explicit JSON representations and
use Zod's built-in JSON Schema generation for CLI metadata.

## Consequences

The lockfile pins the resolved dependency. This decision introduces the
dependency only; command declarations and schema processing are specified in the
[command contract](../commands.md). The command layer must constrain schemas to
supported JSON representations rather than assuming every possible Zod schema
can be serialized.
