interface ProviderToolPayloadSnapshot {
  toolNames: string[];
  tools: unknown[];
}

let latestProviderToolPayloadSnapshot: ProviderToolPayloadSnapshot | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPayloadTools(payload: unknown): unknown[] | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (!("tools" in payload)) {
    return null;
  }

  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return null;
  }
  return tools;
}

function extractToolName(tool: unknown): string | null {
  if (!isRecord(tool)) {
    return null;
  }
  if ("name" in tool && typeof tool.name === "string") {
    return tool.name;
  }
  if (!("function" in tool)) {
    return null;
  }

  const fn = tool.function;
  if (!isRecord(fn)) {
    return null;
  }
  if (!("name" in fn) || typeof fn.name !== "string") {
    return null;
  }
  return fn.name;
}

function sortNames(names: string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

function sameToolNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sortedLeft = sortNames(left);
  const sortedRight = sortNames(right);
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

export function clearProviderToolPayloadSnapshot(): void {
  latestProviderToolPayloadSnapshot = null;
}

export function updateProviderToolPayloadSnapshot(payload: unknown): void {
  const tools = extractPayloadTools(payload);
  if (tools === null) {
    latestProviderToolPayloadSnapshot = null;
    return;
  }

  const toolNames: string[] = [];
  for (const tool of tools) {
    const name = extractToolName(tool);
    if (name === null) {
      latestProviderToolPayloadSnapshot = null;
      return;
    }
    toolNames.push(name);
  }

  latestProviderToolPayloadSnapshot = {
    toolNames,
    tools,
  };
}

export function getProviderToolPayloadSnapshot(activeToolNames: string[]): unknown[] | null {
  if (latestProviderToolPayloadSnapshot === null) {
    return null;
  }
  if (!sameToolNames(latestProviderToolPayloadSnapshot.toolNames, activeToolNames)) {
    return null;
  }
  return latestProviderToolPayloadSnapshot.tools;
}
