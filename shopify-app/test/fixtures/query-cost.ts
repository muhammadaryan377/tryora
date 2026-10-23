/**
 * Requested-cost estimate for Shopify Admin GraphQL, following Shopify's published rules:
 * scalars and enums cost 0, objects cost 1, and a connection costs 2 + first × (cost of one node).
 * Nested connections multiply. Shopify rejects any single query whose requested cost exceeds 1,000
 * (MAX_COST_EXCEEDED) before running it.
 *
 * Without the schema, a field is treated as a connection when it has a `first` argument, an object when it has a
 * selection set, and a scalar otherwise. That matches every field the assistant queries.
 */
import { Kind, parse, type FieldNode, type SelectionSetNode, type ValueNode } from "graphql";

export const SHOPIFY_MAX_QUERY_COST = 1000;

function argValue(value: ValueNode | undefined, variables: Record<string, unknown>): number | null {
  if (!value) return null;
  if (value.kind === Kind.INT) return Number(value.value);
  if (value.kind === Kind.VARIABLE) {
    const resolved = variables[value.name.value];
    return typeof resolved === "number" ? resolved : null;
  }
  return null;
}

function selectionCost(set: SelectionSetNode | undefined, variables: Record<string, unknown>): number {
  if (!set) return 0;
  let cost = 0;
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) cost += fieldCost(selection, variables);
    else if (selection.kind === Kind.INLINE_FRAGMENT) cost += selectionCost(selection.selectionSet, variables);
  }
  return cost;
}

function fieldCost(field: FieldNode, variables: Record<string, unknown>): number {
  if (!field.selectionSet) return 0;
  if (field.name.value === "pageInfo") return 0;
  const first = argValue(field.arguments?.find((argument) => argument.name.value === "first")?.value, variables);
  if (first !== null) {
    // Cost of one node: the selection inside `nodes` or `edges { node }`.
    let node = 0;
    for (const selection of field.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) continue;
      if (selection.name.value === "nodes") node += selectionCost(selection.selectionSet, variables) + 1;
      if (selection.name.value === "edges") {
        const inner = selection.selectionSet?.selections.find((entry) => entry.kind === Kind.FIELD && entry.name.value === "node") as FieldNode | undefined;
        node += selectionCost(inner?.selectionSet, variables) + 1;
      }
    }
    return 2 + first * node;
  }
  return 1 + selectionCost(field.selectionSet, variables);
}

/** Requested cost of the first operation in `query`. */
export function requestedQueryCost(query: string, variables: Record<string, unknown> = {}): number {
  const document = parse(query.replace(/^#graphql\s*/, ""));
  const operation = document.definitions.find((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) throw new Error("No operation");
  return selectionCost(operation.selectionSet, variables);
}
