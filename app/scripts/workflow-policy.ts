import { isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

function asNode(value: unknown): Node | undefined {
  return value && typeof value === "object" && "range" in value
    ? (value as Node)
    : undefined;
}

function mapField(node: Node | undefined, name: string): Node | undefined {
  if (!isMap(node)) return undefined;
  return asNode(node.get(name, true));
}

function scalarName(value: unknown): string | undefined {
  const node = asNode(value);
  return isScalar(node) ? String(node.value) : undefined;
}

function entries(node: Node | undefined): Iterable<[string, Node | undefined]> {
  if (!isMap(node)) return [];
  return node.items.flatMap((pair) => {
    const name = scalarName(pair.key);
    const value = asNode(pair.value);
    return name === undefined || value === undefined ? [] : [[name, value]];
  });
}

function runSteps(node: Node | undefined): Iterable<Node> {
  if (!isSeq(node)) return [];
  return node.items.flatMap((item) => {
    const value = asNode(item);
    return value === undefined ? [] : [value];
  });
}

export function findAmbiguousRunContinuations(
  source: string,
  filename: string,
): string[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map((error) => `${filename}: ${error.message}`);
  }

  const jobs = mapField(document.contents ?? undefined, "jobs");
  const diagnostics: string[] = [];
  for (const [, job] of entries(jobs)) {
    const steps = mapField(job, "steps");
    for (const step of runSteps(steps)) {
      if (!isMap(step)) continue;
      const runNode = mapField(step, "run");
      if (
        !isScalar(runNode) ||
        runNode.type === "BLOCK_LITERAL" ||
        !runNode.range
      )
        continue;

      const rawScalar = source.slice(runNode.range[0], runNode.range[1]);
      const continuation = /\\[\t ]*\r?\n/.exec(rawScalar);
      if (!continuation) continue;

      const offset = runNode.range[0] + continuation.index;
      const line = source.slice(0, offset).split("\n").length;
      diagnostics.push(
        `${filename}:${line}: run shell continuation requires a literal YAML block scalar (|)`,
      );
    }
  }
  return diagnostics;
}
