import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clone,
  createArrayItem,
  errorsForPath,
  listSuggestionOptions,
  listSuggestions,
  normalizeOptions,
  pathKey,
  resolveSelectEmptyOption,
  withValueAtPath,
} from "../lib/config.js";

const modalStack = [];
let originalBodyOverflow = "";

function lockBodyForModal(modalId) {
  if (modalStack.length === 0) {
    originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  modalStack.push(modalId);
}

function unlockBodyForModal(modalId) {
  const index = modalStack.lastIndexOf(modalId);
  if (index >= 0) modalStack.splice(index, 1);
  if (modalStack.length === 0) {
    document.body.style.overflow = originalBodyOverflow;
    originalBodyOverflow = "";
  }
}

function FieldHeading({ descriptor, value, secretMask }) {
  const configuredSecret =
    descriptor.type === "secret" && value === secretMask;

  return (
    <div className="field-label">
      <span>{descriptor.label || descriptor.key}</span>
      {descriptor.key && (
        <span className="field-type-badge">{descriptor.key}</span>
      )}
      {descriptor.restartRequired && (
        <span className="field-type-badge restart-badge">需重启</span>
      )}
      {configuredSecret && (
        <span className="field-type-badge secret-badge">已配置</span>
      )}
    </div>
  );
}

function FieldErrors({ errors, path }) {
  const issues = errorsForPath(errors, path);
  if (issues.length === 0) return null;
  return (
    <div className="field-errors">
      {issues.map((issue, index) => (
        <p key={`${issue.code || "issue"}-${index}`} className="field-error">
          {issue.message}
        </p>
      ))}
    </div>
  );
}

function BooleanControl({ value, onChange, label }) {
  return (
    <div className="toggle-wrapper">
      <span className="toggle-copy">{value ? "已启用" : "已停用"}</span>
      <button
        className={`toggle ${value ? "active" : ""}`}
        type="button"
        role="switch"
        aria-checked={Boolean(value)}
        aria-label={label}
        onClick={() => onChange(!value)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

function SecretControl({
  descriptor,
  value,
  onChange,
  secretMask,
  id,
}) {
  const [visible, setVisible] = useState(false);
  const configured = value === secretMask;
  const displayValue = configured ? "" : (value ?? "");

  return (
    <div className="secret-input-row">
      <input
        id={id}
        className="field-input"
        type={visible ? "text" : "password"}
        value={displayValue}
        placeholder={
          configured
            ? "已配置，不修改则保留"
            : descriptor.placeholder || "请输入密钥"
        }
        autoComplete="new-password"
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        className="btn btn-secondary secret-action"
        type="button"
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? "隐藏" : "显示"}
      </button>
      <button
        className="btn btn-secondary secret-action"
        type="button"
        onClick={() => onChange("")}
        disabled={!configured && displayValue === ""}
      >
        清空
      </button>
    </div>
  );
}

function SelectControl({ descriptor, value, onChange, draft, id }) {
  const options = normalizeOptions(descriptor, draft);
  const emptyOption = resolveSelectEmptyOption(descriptor, value);
  const listId = `${id}-options`;

  if (descriptor.allowCustom) {
    return (
      <>
        <input
          id={id}
          className="field-input"
          type="text"
          list={listId}
          value={value ?? ""}
          placeholder={descriptor.placeholder || "可选择或自行填写"}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={listId}>
          {options.map((option) => (
            <option key={JSON.stringify(option.value)} value={option.value}>
              {option.label}
            </option>
          ))}
        </datalist>
      </>
    );
  }

  const known = options.some(
    (option) => String(option.value) === String(value ?? "")
  );
  return (
    <select
      id={id}
      className="field-input"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {emptyOption && (
        <option value="" disabled={emptyOption.disabled}>
          {emptyOption.label}
        </option>
      )}
      {!known && value !== undefined && value !== null && value !== "" && (
        <option value={value}>{String(value)}</option>
      )}
      {options.map((option) => (
        <option key={JSON.stringify(option.value)} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function normalizeRemoteModels(models) {
  const seen = new Set();
  const values = [];
  for (const model of Array.isArray(models) ? models : []) {
    const value = String(model ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function ModelSelectControl({
  descriptor,
  value,
  onChange,
  draft,
  formValue,
  loadProviderModels,
  id,
}) {
  const providerField = descriptor.providerField || "provider";
  const providerId = String(formValue?.[providerField] || "").trim();
  const provider = useMemo(
    () =>
      (Array.isArray(draft?.ai?.providers) ? draft.ai.providers : []).find(
        (item) => item?.id === providerId
      ) || null,
    [draft, providerId]
  );
  const providerSignature = useMemo(
    () => JSON.stringify(provider),
    [provider]
  );
  const [reloadVersion, setReloadVersion] = useState(0);
  const [state, setState] = useState({
    status: "idle",
    models: [],
    error: "",
  });

  useEffect(() => {
    if (!providerId) {
      setState({ status: "idle", models: [], error: "" });
      return undefined;
    }
    if (!provider) {
      setState({
        status: "error",
        models: [],
        error: `未找到供应商“${providerId}”`,
      });
      return undefined;
    }
    if (typeof loadProviderModels !== "function") {
      setState({
        status: "error",
        models: [],
        error: "配置服务不支持读取模型列表",
      });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setState({ status: "loading", models: [], error: "" });
    void loadProviderModels(provider, { signal: controller.signal })
      .then((models) => {
        if (!active) return;
        setState({
          status: "success",
          models: normalizeRemoteModels(models),
          error: "",
        });
      })
      .catch((error) => {
        if (!active || error?.name === "AbortError") return;
        setState({
          status: "error",
          models: [],
          error: error?.message || "模型列表加载失败",
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    loadProviderModels,
    providerId,
    providerSignature,
    reloadVersion,
  ]);

  const currentValue = String(value ?? "");
  const knownValue = state.models.includes(currentValue);
  const loading = state.status === "loading";
  const selectable = state.status === "success" && state.models.length > 0;
  const placeholder = !providerId
    ? "请先选择供应商"
    : loading
      ? "正在读取模型列表……"
      : state.status === "error"
        ? "模型列表加载失败"
        : state.models.length === 0
          ? "模型端点没有返回可选模型"
          : "请选择模型";

  return (
    <div className="model-select-control">
      <div className="model-select-row">
        <select
          id={id}
          className="field-input"
          value={currentValue}
          disabled={!selectable}
          aria-busy={loading}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {currentValue && !knownValue && (
            <option value={currentValue} disabled>
              {currentValue}（当前配置，端点未返回）
            </option>
          )}
          {state.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <button
          className="btn btn-secondary model-select-reload"
          type="button"
          disabled={!provider || loading}
          onClick={() => setReloadVersion((current) => current + 1)}
        >
          {loading ? "加载中…" : "重新加载"}
        </button>
      </div>
      {state.status === "error" && (
        <div className="model-select-message error">{state.error}</div>
      )}
      {state.status === "success" && state.models.length === 0 && (
        <div className="model-select-message">
          所选供应商的模型端点没有返回可用于选择的模型。
        </div>
      )}
    </div>
  );
}

function PrimitiveControl({
  descriptor,
  value,
  onChange,
  draft,
  formValue,
  loadProviderModels,
  secretMask,
  id,
}) {
  if (descriptor.type === "boolean") {
    return (
      <BooleanControl
        value={Boolean(value)}
        onChange={onChange}
        label={descriptor.label || descriptor.key}
      />
    );
  }
  if (descriptor.type === "secret") {
    return (
      <SecretControl
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        secretMask={secretMask}
        id={id}
      />
    );
  }
  if (descriptor.type === "modelSelect") {
    return (
      <ModelSelectControl
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        draft={draft}
        formValue={formValue}
        loadProviderModels={loadProviderModels}
        id={id}
      />
    );
  }
  if (descriptor.type === "select") {
    return (
      <SelectControl
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        draft={draft}
        id={id}
      />
    );
  }
  if (descriptor.type === "textarea") {
    return (
      <textarea
        id={id}
        className="field-input field-textarea"
        rows={descriptor.rows || 4}
        value={value ?? ""}
        placeholder={descriptor.placeholder || ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const isNumber = descriptor.type === "number";
  return (
    <input
      id={id}
      className="field-input"
      type={
        isNumber ? "number" : descriptor.type === "url" ? "url" : "text"
      }
      value={value ?? ""}
      min={descriptor.min}
      max={descriptor.max}
      step={descriptor.step}
      placeholder={descriptor.placeholder || ""}
      onChange={(event) =>
        onChange(
          isNumber && event.target.value !== ""
            ? Number(event.target.value)
            : event.target.value
        )
      }
    />
  );
}

function ModalFrame({
  title,
  subtitle,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  error,
}) {
  const modalId = useRef(Symbol("config-modal")).current;
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    lockBodyForModal(modalId);
    const onKeyDown = (event) => {
      if (event.key === "Escape" && modalStack.at(-1) === modalId) {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      unlockBodyForModal(modalId);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modalId]);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "编辑配置项"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          <button
            className="modal-close"
            type="button"
            onClick={onCancel}
            aria-label="关闭"
          >
            ✕
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onConfirm();
          }}
        >
          <div className="modal-body">
            {children}
            {error && <p className="modal-error">{error}</p>}
          </div>
          <footer className="modal-footer">
            <button className="btn btn-secondary" type="button" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn-primary" type="submit">
              {confirmLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  );
}

function ValueCreateModal({
  descriptor,
  values,
  draft,
  onConfirm,
  onCancel,
}) {
  const isNumber = descriptor.type === "numberList";
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  const suggestions = isNumber ? [] : listSuggestions(descriptor, draft);

  const confirm = () => {
    const text = value.trim();
    if (!text) {
      setError("内容不能为空");
      return;
    }
    const next = isNumber ? Number(text) : text;
    if (isNumber && !Number.isFinite(next)) {
      setError("请输入有效数字");
      return;
    }
    if (values.some((item) => Object.is(item, next))) {
      setError(`“${next}”已经在列表中`);
      return;
    }
    onConfirm(next);
  };

  return (
    <ModalFrame
      title={`添加${descriptor.label || "数组项"}`}
      subtitle="确认后才会加入当前草稿。"
      confirmLabel="确定添加"
      onConfirm={confirm}
      onCancel={onCancel}
      error={error}
    >
      <div className="field-group">
        <label className="field-label" htmlFor={id}>
          {isNumber ? "数值" : "内容"}
        </label>
        <input
          id={id}
          className="field-input"
          type={isNumber ? "number" : "text"}
          value={value}
          list={suggestions.length > 0 ? `${id}-suggestions` : undefined}
          placeholder={
            descriptor.placeholder ||
            (isNumber ? "请输入数字" : "请输入内容")
          }
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
          autoFocus
        />
        {suggestions.length > 0 && (
          <datalist id={`${id}-suggestions`}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        )}
      </div>
    </ModalFrame>
  );
}

function MultiValueModal({
  descriptor,
  values,
  draft,
  onConfirm,
  onCancel,
}) {
  const suggested = listSuggestionOptions(descriptor, draft);
  const [selected, setSelected] = useState(() => new Set(values.map(String)));
  const [extraOptions, setExtraOptions] = useState([]);
  const [search, setSearch] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [error, setError] = useState("");

  const allOptions = useMemo(() => {
    const byValue = new Map(
      suggested.map((option) => [option.value, option])
    );
    for (const value of [...values, ...extraOptions].map(String)) {
      if (!byValue.has(value)) {
        byValue.set(value, { value, label: value });
      }
    }
    return [...byValue.values()];
  }, [extraOptions, suggested, values]);
  const visibleOptions = allOptions.filter((option) => {
    const query = search.trim().toLowerCase();
    return [option.value, option.label, option.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const toggle = (value) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const addCustom = () => {
    const value = customValue.trim();
    if (!value) {
      setError(`${descriptor.itemNoun || "项目"}名称不能为空`);
      return;
    }
    setExtraOptions((current) =>
      current.includes(value) ? current : [...current, value]
    );
    setSelected((current) => new Set([...current, value]));
    setCustomValue("");
    setError("");
  };

  return (
    <ModalFrame
      title={`选择${descriptor.label || "项目"}`}
      subtitle={`已选择 ${selected.size} 项，可一次确认多个${
        descriptor.itemNoun || "项目"
      }。`}
      confirmLabel={`确定选择（${selected.size}）`}
      onConfirm={() =>
        onConfirm(
          allOptions
            .map((option) => option.value)
            .filter((value) => selected.has(value))
        )
      }
      onCancel={onCancel}
      error={error}
    >
      <div className="multi-select-toolbar">
        <label className="multi-select-search">
          <span aria-hidden="true">⌕</span>
          <input
            className="field-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              descriptor.searchPlaceholder ||
              `搜索${descriptor.itemNoun || "项目"}`
            }
            autoFocus
          />
        </label>
        <div className="multi-select-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() =>
              setSelected(
                (current) =>
                  new Set([
                    ...current,
                    ...visibleOptions.map((option) => option.value),
                  ])
              )
            }
          >
            全选当前
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => setSelected(new Set())}
          >
            清空
          </button>
        </div>
      </div>

      <div className="multi-select-list">
        {visibleOptions.map((option) => (
          <label
            className={`multi-select-option ${
              selected.has(option.value) ? "selected" : ""
            }`}
            key={option.value}
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={() => toggle(option.value)}
            />
            <span className="multi-select-check" aria-hidden="true">
              {selected.has(option.value) ? "✓" : ""}
            </span>
            <span className="multi-select-copy">
              <strong>{option.label}</strong>
              {option.label !== option.value && <small>{option.value}</small>}
              {option.description && <small>{option.description}</small>}
            </span>
            <span className="multi-select-badges">
              {option.kind && (
                <small className="multi-select-kind">
                  {option.kind === "local"
                    ? "本地"
                    : option.kind === "prompt"
                      ? "提示词"
                      : option.kind}
                </small>
              )}
              {option.masterOnly && (
                <small className="multi-select-kind">主人</small>
              )}
              {option.enabled === false && (
                <small className="multi-select-kind">未启用</small>
              )}
            </span>
          </label>
        ))}
        {visibleOptions.length === 0 && (
          <div className="object-array-empty">
            没有匹配的{descriptor.itemNoun || "项目"}
          </div>
        )}
      </div>

      {descriptor.allowCustom !== false && (
        <div className="multi-select-custom">
          <input
            className="field-input"
            type="text"
            value={customValue}
            onChange={(event) => {
              setCustomValue(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustom();
              }
            }}
            placeholder={
              descriptor.customPlaceholder ||
              `自定义${descriptor.itemNoun || "项目"}名称`
            }
          />
          <button
            className="btn btn-secondary"
            type="button"
            onClick={addCustom}
          >
            加入选择
          </button>
        </div>
      )}
    </ModalFrame>
  );
}

function SimpleListField({
  descriptor,
  value,
  onChange,
  draft,
  path,
  errors,
}) {
  const [adding, setAdding] = useState(false);
  const items = Array.isArray(value) ? value : [];
  const invalid = errorsForPath(errors, path, false).length > 0;

  return (
    <div className={`field-group ${invalid ? "invalid" : ""}`}>
      <FieldHeading descriptor={descriptor} value={value} />
      {descriptor.help && <div className="field-help">{descriptor.help}</div>}
      <div className="array-field">
        {items.map((item, index) => (
          <span className="array-tag" key={`${String(item)}-${index}`}>
            {String(item)}
            <button
              className="array-tag-remove"
              type="button"
              onClick={() =>
                onChange(items.filter((_, itemIndex) => itemIndex !== index))
              }
              aria-label={`删除 ${item}`}
            >
              ✕
            </button>
          </span>
        ))}
        <button
          className="array-add-trigger"
          type="button"
          onClick={() => setAdding(true)}
        >
          {descriptor.multiSelect
            ? `＋ 选择${descriptor.itemNoun || "项目"}`
            : "＋ 添加一项"}
        </button>
      </div>
      <FieldErrors errors={errors} path={path} />

      {adding && descriptor.multiSelect && (
        <MultiValueModal
          descriptor={descriptor}
          values={items}
          draft={draft}
          onCancel={() => setAdding(false)}
          onConfirm={(nextItems) => {
            onChange(nextItems);
            setAdding(false);
          }}
        />
      )}

      {adding && !descriptor.multiSelect && (
        <ValueCreateModal
          descriptor={descriptor}
          values={items}
          draft={draft}
          onCancel={() => setAdding(false)}
          onConfirm={(item) => {
            onChange([...items, item]);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function uniqueRecordKey(record, base = "KEY") {
  if (!(base in record)) return base;
  let index = 2;
  while (`${base}_${index}` in record) index += 1;
  return `${base}_${index}`;
}

function RecordField({
  descriptor,
  value,
  onChange,
  path,
  errors,
  secretMask,
}) {
  const record = value && typeof value === "object" ? value : {};
  const entries = Object.entries(record);

  const rename = (oldKey, nextKey, nextValue) => {
    const next = {};
    for (const [key, item] of entries) {
      if (key === oldKey) {
        next[nextKey] = nextValue;
      } else {
        next[key] = item;
      }
    }
    onChange(next);
  };

  return (
    <div className="field-group">
      <FieldHeading descriptor={descriptor} value={value} />
      {descriptor.help && <div className="field-help">{descriptor.help}</div>}
      <div className="record-editor">
        {entries.map(([key, item]) => {
          const itemPath = [...path, key];
          const configured = descriptor.secretValues && item === secretMask;
          return (
            <div className="record-row" key={key}>
              <input
                className="field-input"
                type="text"
                value={key}
                aria-label="键名"
                onChange={(event) => rename(key, event.target.value, item)}
              />
              <input
                className="field-input"
                type={descriptor.secretValues ? "password" : "text"}
                value={configured ? "" : (item ?? "")}
                placeholder={
                  configured ? "已配置，不修改则保留" : "值"
                }
                aria-label={`${key} 的值`}
                onChange={(event) => rename(key, key, event.target.value)}
              />
              <button
                className="record-remove"
                type="button"
                onClick={() =>
                  onChange(
                    Object.fromEntries(
                      entries.filter(([entryKey]) => entryKey !== key)
                    )
                  )
                }
                aria-label={`删除 ${key}`}
              >
                ✕
              </button>
              <FieldErrors errors={errors} path={itemPath} />
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className="object-array-empty">当前没有键值项</div>
        )}
        <button
          className="btn btn-secondary object-array-add"
          type="button"
          onClick={() => {
            const key = uniqueRecordKey(record);
            onChange({ ...record, [key]: "" });
          }}
        >
          ＋ 添加键值
        </button>
      </div>
      <FieldErrors errors={errors} path={path} />
    </div>
  );
}

function ItemModal({
  descriptor,
  initialValue,
  itemPath,
  itemIndex,
  mode,
  rootDraft,
  errors,
  secretMask,
  loadProviderModels,
  existingItems,
  onConfirm,
  onCancel,
}) {
  const [itemDraft, setItemDraft] = useState(() => clone(initialValue));
  const [modalError, setModalError] = useState("");
  const itemKey = descriptor.itemKey;
  const itemLabel = descriptor.itemLabel || "配置项";

  const confirm = () => {
    if (itemKey) {
      const value = String(itemDraft?.[itemKey] ?? "").trim();
      if (!value) {
        const field = (descriptor.fields || []).find(
          (entry) => entry.key === itemKey
        );
        setModalError(`${field?.label || itemKey}不能为空`);
        return;
      }
      const duplicate = existingItems.some(
        (item, index) =>
          (mode === "add" || index !== itemIndex) &&
          String(item?.[itemKey] ?? "").trim() === value
      );
      if (duplicate) {
        setModalError(`${itemLabel}“${value}”已经存在`);
        return;
      }
    }
    onConfirm(itemDraft);
  };

  const summary = itemKey ? itemDraft?.[itemKey] : itemIndex + 1;

  return (
    <ModalFrame
      title={
        <>
          {mode === "add" ? `添加${itemLabel}` : `编辑${itemLabel}`}
          {mode === "edit" && (
            <span className="modal-item-number">{String(summary || itemIndex + 1)}</span>
          )}
        </>
      }
      subtitle={
        mode === "add"
          ? "填写完整配置后确认，取消不会留下未完成项目。"
          : "修改只会写入当前草稿，仍需在主页面保存配置。"
      }
      confirmLabel={mode === "add" ? "确定添加" : "确定保存"}
      onConfirm={confirm}
      onCancel={onCancel}
      error={modalError}
    >
      {(descriptor.fields || []).map((field) => (
        <ConfigField
          key={field.key}
          descriptor={field}
          value={itemDraft?.[field.key]}
          onChange={(value) => {
            setItemDraft((current) => {
              const changed = !Object.is(current?.[field.key], value);
              let next = withValueAtPath(current, [field.key], value);
              if (changed) {
                for (const dependentKey of field.clearOnChange || []) {
                  next = withValueAtPath(next, [dependentKey], "");
                }
              }
              return next;
            });
            setModalError("");
          }}
          path={[...itemPath, field.key]}
          draft={rootDraft}
          formValue={itemDraft}
          errors={errors}
          secretMask={secretMask}
          loadProviderModels={loadProviderModels}
          inModal
        />
      ))}
    </ModalFrame>
  );
}

function ObjectArrayField({
  descriptor,
  value,
  onChange,
  path,
  draft,
  errors,
  secretMask,
  loadProviderModels,
  root = false,
}) {
  const [modal, setModal] = useState(null);
  const items = Array.isArray(value) ? value : [];
  const itemLabel = descriptor.itemLabel || "配置项";
  const minItems = descriptor.minItems || 0;

  const itemSummary = (item, index) => {
    const keys = [
      descriptor.itemKey,
      "name",
      "id",
      "trigger",
      "prefix",
      "command",
    ].filter(Boolean);
    for (const key of keys) {
      if (item?.[key] !== undefined && item[key] !== "") {
        return String(item[key]);
      }
    }
    return `${itemLabel} ${index + 1}`;
  };

  const content = (
    <>
      {!root && (
        <>
          <FieldHeading descriptor={descriptor} value={value} />
          {descriptor.help && (
            <div className="field-help">{descriptor.help}</div>
          )}
        </>
      )}

      <div className="object-array-container">
        {items.map((item, index) => {
          const itemPath = [...path, index];
          const invalid = errorsForPath(errors, itemPath, false).length > 0;
          return (
            <div
              className={`object-array-item ${invalid ? "invalid" : ""}`}
              key={`${itemSummary(item, index)}-${index}`}
            >
              <button
                className="object-array-header"
                type="button"
                onClick={() =>
                  setModal({
                    mode: "edit",
                    index,
                    initialValue: clone(item),
                  })
                }
              >
                <span className="object-array-toggle" aria-hidden="true">
                  ✎
                </span>
                <span className="object-array-summary">
                  <span className="array-item-number">{index + 1}</span>
                  {itemSummary(item, index)}
                </span>
                {invalid && <span className="array-error-badge">需检查</span>}
                <span className="object-array-edit">编辑</span>
              </button>
              <button
                className="object-array-remove"
                type="button"
                disabled={items.length <= minItems}
                onClick={() => {
                  if (
                    window.confirm(
                      `确定从草稿中删除${itemLabel}“${itemSummary(item, index)}”吗？`
                    )
                  ) {
                    onChange(items.filter((_, itemIndex) => itemIndex !== index));
                  }
                }}
                aria-label={`删除 ${itemSummary(item, index)}`}
              >
                ✕
              </button>
            </div>
          );
        })}

        {items.length === 0 && (
          <div className="object-array-empty">当前还没有{itemLabel}</div>
        )}

        <button
          className="btn btn-secondary object-array-add"
          type="button"
          onClick={() =>
            setModal({
              mode: "add",
              index: items.length,
              initialValue: createArrayItem(descriptor, items),
            })
          }
        >
          ＋ 添加{itemLabel}
        </button>
      </div>
      <FieldErrors errors={errors} path={path} />

      {modal && (
        <ItemModal
          key={`${modal.mode}-${modal.index}`}
          descriptor={descriptor}
          initialValue={modal.initialValue}
          itemPath={[...path, modal.index]}
          itemIndex={modal.index}
          mode={modal.mode}
          rootDraft={draft}
          errors={errors}
          secretMask={secretMask}
          loadProviderModels={loadProviderModels}
          existingItems={items}
          onCancel={() => setModal(null)}
          onConfirm={(nextItem) => {
            if (modal.mode === "add") {
              onChange([...items, nextItem]);
            } else {
              const next = clone(items);
              next[modal.index] = nextItem;
              onChange(next);
            }
            setModal(null);
          }}
        />
      )}
    </>
  );

  return root ? (
    content
  ) : (
    <div
      className={`field-group object-array-field ${
        errorsForPath(errors, path, false).length > 0 ? "invalid" : ""
      }`}
      data-path={pathKey(path)}
    >
      {content}
    </div>
  );
}

export default function ConfigField({
  descriptor,
  value,
  onChange,
  path,
  draft,
  errors = [],
  secretMask,
  formValue,
  loadProviderModels,
  inModal = false,
}) {
  const id = useId();
  const exactErrors = errorsForPath(errors, path);
  const invalid = exactErrors.length > 0;
  const fieldClass = `field-group ${invalid ? "invalid" : ""}`;

  const childDescriptors = useMemo(
    () => descriptor.fields || [],
    [descriptor.fields]
  );

  if (descriptor.type === "array") {
    return (
      <ObjectArrayField
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        path={path}
        draft={draft}
        errors={errors}
        secretMask={secretMask}
        loadProviderModels={loadProviderModels}
      />
    );
  }

  if (["stringList", "numberList"].includes(descriptor.type)) {
    return (
      <SimpleListField
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        draft={draft}
        path={path}
        errors={errors}
      />
    );
  }

  if (descriptor.type === "record") {
    return (
      <RecordField
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        path={path}
        errors={errors}
        secretMask={secretMask}
      />
    );
  }

  if (descriptor.type === "object") {
    const objectValue =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <section className={`${fieldClass} nested-section`}>
        <FieldHeading
          descriptor={descriptor}
          value={value}
          secretMask={secretMask}
        />
        {descriptor.help && <div className="field-help">{descriptor.help}</div>}
        <div className="nested-fields">
          {childDescriptors.map((field) => (
            <ConfigField
              key={field.key}
              descriptor={field}
              value={objectValue[field.key]}
              onChange={(nextValue) =>
                onChange(
                  withValueAtPath(objectValue, [field.key], nextValue)
                )
              }
              path={[...path, field.key]}
              draft={draft}
              formValue={objectValue}
              errors={errors}
              secretMask={secretMask}
              loadProviderModels={loadProviderModels}
              inModal={inModal}
            />
          ))}
        </div>
        <FieldErrors errors={errors} path={path} />
      </section>
    );
  }

  return (
    <div className={fieldClass} data-path={pathKey(path)}>
      <label htmlFor={descriptor.type === "boolean" ? undefined : id}>
        <FieldHeading
          descriptor={descriptor}
          value={value}
          secretMask={secretMask}
        />
      </label>
      {descriptor.help && <div className="field-help">{descriptor.help}</div>}
      <PrimitiveControl
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        draft={draft}
        formValue={formValue}
        loadProviderModels={loadProviderModels}
        secretMask={secretMask}
        id={id}
      />
      <FieldErrors errors={errors} path={path} />
    </div>
  );
}

export { ObjectArrayField };
