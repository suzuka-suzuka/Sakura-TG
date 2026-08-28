import ConfigField, { ObjectArrayField } from "./ConfigField.jsx";
import {
  descriptorMatches,
  getAtPath,
  sectionPath,
} from "../lib/config.js";

export default function ConfigSection({
  section,
  draft,
  errors,
  secretMask,
  search,
  onChange,
  loadProviderModels,
}) {
  const rootPath = sectionPath(section);
  const rootValue = getAtPath(draft, rootPath);

  return (
    <div className="config-section">
      <div className="section-title">
        <span className="section-icon" aria-hidden="true">
          {section.icon || "✦"}
        </span>
        {section.title}
      </div>
      {section.description && (
        <div className="section-desc">{section.description}</div>
      )}

      {section.type === "array" ? (
        <ObjectArrayField
          descriptor={section}
          value={rootValue}
          onChange={(value) => onChange(rootPath, value)}
          path={rootPath}
          draft={draft}
          errors={errors}
          secretMask={secretMask}
          loadProviderModels={loadProviderModels}
          root
        />
      ) : (
        <>
          {(section.fields || [])
            .filter((field) => descriptorMatches(field, search))
            .map((field) => (
              <ConfigField
                key={field.key}
                descriptor={field}
                value={rootValue?.[field.key]}
                onChange={(value) =>
                  onChange([...rootPath, field.key], value)
                }
                path={[...rootPath, field.key]}
                draft={draft}
                errors={errors}
                secretMask={secretMask}
                formValue={rootValue}
                loadProviderModels={loadProviderModels}
              />
            ))}
          {search &&
            !(section.fields || []).some((field) =>
              descriptorMatches(field, search)
            ) && <div className="empty-state">没有匹配的配置字段</div>}
        </>
      )}
    </div>
  );
}
