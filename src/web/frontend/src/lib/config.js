export function clone(value) {
  return structuredClone(value);
}

export function pathKey(path) {
  return (path || []).map(String).join(".");
}

export function pathStartsWith(path, prefix) {
  return (
    prefix.length <= path.length &&
    prefix.every((part, index) => String(path[index]) === String(part))
  );
}

export function splitPath(path) {
  return Array.isArray(path)
    ? path
    : String(path || "")
        .split(".")
        .filter(Boolean);
}

export function getAtPath(object, path) {
  return splitPath(path).reduce((value, key) => value?.[key], object);
}

export function withValueAtPath(object, path, value) {
  const keys = splitPath(path);
  if (keys.length === 0) return clone(value);

  const next = clone(object);
  let cursor = next;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return next;
}

export function normalizeOptions(descriptor, draft) {
  const options = [];
  const signatures = new Set();
  const add = (value, label = value) => {
    const signature = JSON.stringify(value);
    if (signatures.has(signature)) return;
    signatures.add(signature);
    options.push({ value, label: String(label ?? value) });
  };

  for (const option of descriptor.options || []) {
    if (option && typeof option === "object" && "value" in option) {
      add(option.value, option.label);
    } else {
      add(option);
    }
  }

  const source = descriptor.optionsFrom;
  for (const sourcePath of source?.paths || []) {
    const values = getAtPath(draft, sourcePath);
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      const value =
        item && typeof item === "object" ? item[source.valueKey] : item;
      if (value !== undefined && value !== null && value !== "") add(value);
    }
  }

  return options;
}

export function resolveSelectEmptyOption(descriptor, value) {
  const empty = value === undefined || value === null || value === "";
  if (!descriptor?.allowEmpty && !empty) return null;

  return {
    label:
      descriptor?.placeholder ||
      (descriptor?.allowEmpty ? "未选择" : "请选择"),
    disabled: descriptor?.allowEmpty !== true,
  };
}

export function listSuggestionOptions(descriptor, draft) {
  const options = [];
  const seen = new Set();
  const add = (suggestion) => {
    const normalized =
      suggestion && typeof suggestion === "object"
        ? {
            ...suggestion,
            value: String(suggestion.value ?? suggestion.key ?? ""),
            label: String(
              suggestion.label ??
                suggestion.value ??
                suggestion.key ??
                ""
            ),
          }
        : {
            value: String(suggestion ?? ""),
            label: String(suggestion ?? ""),
          };
    if (!normalized.value || seen.has(normalized.value)) return;
    seen.add(normalized.value);
    options.push(normalized);
  };

  for (const suggestion of descriptor.suggestions || []) add(suggestion);
  const source = descriptor.suggestionsFrom;
  for (const sourcePath of source?.paths || []) {
    const list = getAtPath(draft, sourcePath);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const raw =
        item && typeof item === "object" ? item[source.valueKey] : item;
      if (raw !== undefined && raw !== null && raw !== "") {
        add(`${source.prefix || ""}${raw}`);
      }
    }
  }
  return options;
}

export function listSuggestions(descriptor, draft) {
  return listSuggestionOptions(descriptor, draft).map(
    (option) => option.value
  );
}

export function sectionPath(section) {
  return splitPath(section.root);
}

export function errorsForPath(errors, path, exact = true) {
  return (errors || []).filter((error) => {
    const issuePath = error.path || [];
    return exact
      ? pathKey(issuePath) === pathKey(path)
      : pathStartsWith(issuePath, path);
  });
}

export function descriptorMatches(descriptor, term) {
  const query = term.trim().toLowerCase();
  if (!query) return true;
  const ownText = [
    descriptor.key,
    descriptor.label,
    descriptor.title,
    descriptor.help,
    descriptor.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    ownText.includes(query) ||
    (descriptor.fields || []).some((field) =>
      descriptorMatches(field, query)
    )
  );
}

export function createArrayItem(descriptor) {
  return clone(descriptor.template || {});
}
