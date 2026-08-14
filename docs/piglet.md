---
title: Piglet
group: Runtime & Format
groupOrder: 2
order: 5
---
# Piglet

Piglet is Wurster's composition capability: running Wursts inside Wursts.

The contained file remains a normal Wurst. "Piglet" is the runtime system for Wurst-in-Wurst composition. Its full target includes managed embed/start/stop/focus lifecycle and communication handles; v0.32 implements the built-in child/package slice and Web internal-session path first.

## Status In 0.32.0

Piglet has a first functional slice:

- MeatGrinder can pack fixed child `.wurst` / `.wrst` files from `piglet.children`.
- The parent manifest records each child id, immutable entry path, byte length, SHA-256 digest and child application identity summary.
- Parent package signatures cover the exact child bytes.
- Wurster Web can list children, serve child bytes through a runtime-owned Piglet URL and open a child as an internal `WursterWebSession`.
- Desktop Wurster exposes child listing and runtime-owned child URLs to Wurst code.

Full Desktop embedding as separate managed child renderer surfaces, start/stop/focus handles, direct brokered PigLink handles, tree-level resource budgets and installed mutable children remain follow-up work. Pigsty permission state remains independent for every child.

## Embedded, Not Relaunched

If Desktop Wurster opens a Wurst that contains another Wurst, opening that child internally does not create another Electron application window by default. The child is embedded wherever the parent asks Wurster to place it.

That makes Wursts usable as modules, panels, tools, desktop-like app surfaces or components of a larger portable system.

## Manifest

```json
{
  "piglet": {
    "children": [
      {
        "id": "texture-inspector",
        "source": "tools/TextureInspector.wurst",
        "label": "Texture Inspector"
      }
    ]
  }
}
```

`source` points to a project-relative `.wurst` or `.wrst` file. MeatGrinder copies the exact child bytes into immutable package scope `piglet`.

## Trust Domains Stay Separate

Nesting does not merge trust.

A child Wurst keeps its own:

- package signature;
- publisher identity;
- WurstFS realms;
- WurstKey requirements;
- Pigsty permission state;
- PigLink declarations;
- runtime capabilities.

The parent can orchestrate lifecycle. It does not automatically own the child's secrets or permissions.

```text
Parenthood grants orchestration, not omnipotence.
```

## Built-In Children

If a parent ships a child Wurst as immutable content, the parent signature covers the exact child bytes. The child still keeps its own signature.

This says two different things:

- Parent signature: these exact bytes are part of my signed package.
- Child signature: this child Wurst was published by its own signer.

If the child bytes are swapped, parent integrity breaks. If the child publisher is later revoked, parent integrity may still be valid while Wurster refuses to auto-start the child or clearly warns the user.

## Installed Children

A Wurst installed later into something like `WurstOS.wurst` lives in the mutable state of the parent. The parent signature makes no claim about it. Wurster verifies the installed child independently.

## Resource Budgets

Piglet needs tree-level budgets. A parent must not exhaust CPU, memory, process slots, Pigsty workers, open PigLinks or nesting depth by recursively launching children.

Budgets belong to the whole Wurst tree, not only to each individual node.
