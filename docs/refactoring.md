# Refactoring Notes

This document records refactoring guidelines that came out of the CLI `Header`
cleanup. The same checks should apply when refactoring other components.

## Prefer Domain Inputs At Component Boundaries

If a component exists to render one domain object, prefer passing that object
directly instead of pre-extracting a parallel props shape at every call site.

Example:

```tsx
<Header workflow={workflow} />
```

This keeps the call site small and makes the component the single owner of how
that domain object maps to the UI.

Use separate view props only when one of these is true:

- The component is intentionally reusable across multiple domain objects.
- The mapping is expensive or shared by several independent render paths.
- The caller must choose between multiple presentation variants.
- The component is a low-level primitive that should not import domain types.

## Do Not Add Defensive Props For Invalid Domain States

If upstream validation makes a field required, represent it as required in the
component API too. Do not make the component accept `null` or fallback values
for states that the domain model rejects.

For validated Serverless Workflow documents, `document.namespace`,
`document.name`, and `document.version` are required. A component rendering a
validated workflow header should read them as required strings, not as optional
display hints.

Defensive rendering is still appropriate for fields that are truly optional in
the spec, such as `title` and `summary`.

## Inline Single-Use Extraction

Avoid helper functions whose only job is to reshape data for the component that
immediately calls them. They add an extra naming layer without creating a useful
abstraction.

Prefer:

```tsx
export function Header({ workflow }: HeaderProps) {
  const { namespace, name, version, title, summary } = workflow.document;
  // render...
}
```

Introduce an extraction helper only when it has a clear second reason to exist:

- It is reused by multiple components or non-rendering code.
- It contains non-trivial transformation rules.
- It is independently tested because the mapping itself is business logic.
- It creates a stable boundary between a volatile external shape and local UI.

## Keep Layout Fixes In The Right Layer

When a rendering issue depends on the output environment, pass the environment
constraint to the renderer rather than hard-coding arbitrary component limits.

For Ink `renderToString`, prefer passing the actual render width:

```tsx
renderToString(<Header workflow={workflow} />, { columns: process.stdout.columns });
```

Avoid fixed maximum widths unless the product explicitly defines that width as
part of the visual design.

## Test Invariants, Not Just Snapshots

Snapshot-style expectations are useful for small stable outputs, but they can
hide the reason a refactor matters. For layout behavior, add invariant tests
that describe the contract.

Good invariants:

- Rendered lines do not exceed the requested width.
- Long unbroken values wrap within the requested width.
- Wider render widths are not artificially capped.
- Required domain fields are passed through without fallback display values.

Use exact output tests only when the precise text layout is itself part of the
contract and the case is small enough to review.

## Refactoring Checklist

Before finishing a component refactor, check:

- Is the component API aligned with the validated domain model?
- Are required domain fields represented as required types?
- Are optional fields optional because the spec says so, not because we guessed?
- Did any helper survive only because it used to exist?
- Is layout controlled by the renderer/environment when appropriate?
- Do tests assert the behavior that would catch the original problem?
- Did the call site become simpler or at least more honest?
