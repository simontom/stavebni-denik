import React from "react";
import { CORE, SECTIONS, limitOf, type FieldSpec, type ProjectFieldValues } from "../lib/projectFields";
import { Field, TextArea, TextInput } from "./ui";

const ProjectField: React.FC<{ spec: FieldSpec; values: ProjectFieldValues; onChange: (patch: Partial<ProjectFieldValues>) => void }> = ({ spec, values, onChange }) => {
  const value = values[spec.key];
  const limit = limitOf(spec);
  return (
    <Field label={spec.label} className={spec.type === "textarea" ? "md:col-span-2" : undefined}>
      {spec.type === "textarea" ? (
        <TextArea name={spec.key} value={value} onChange={(e) => onChange({ [spec.key]: e.target.value })} rows={3} placeholder={spec.placeholder} />
      ) : (
        <TextInput
          name={spec.key}
          type={spec.type ?? "text"}
          required={spec.required}
          value={value}
          onChange={(e) => onChange({ [spec.key]: e.target.value })}
          placeholder={spec.placeholder}
        />
      )}
      {limit !== null && value.length > limit * 0.9 && (
        <p className={`mt-1 text-xs ${value.length > limit ? "font-semibold text-danger-ink" : "text-ink-muted"}`}>
          {value.length} / {limit} znaků
        </p>
      )}
    </Field>
  );
};

/**
 * The fields of a project. [children] are put into the grid of the always-asked fields (the page that creates a project adds
 * the choice of the site manager there).
 */
export const ProjectFields: React.FC<{
  values: ProjectFieldValues;
  onChange: (patch: Partial<ProjectFieldValues>) => void;
  children?: React.ReactNode;
}> = ({ values, onChange, children }) => (
  <>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {CORE.map((spec) => (
        <ProjectField key={spec.key} spec={spec} values={values} onChange={onChange} />
      ))}
      {children}
    </div>
    {SECTIONS.map((section) => (
      <div key={section.title} className="mt-4 border-t border-line pt-4">
        <h2 className="text-md mb-3 font-semibold text-ink">{section.title}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {section.fields.map((spec) => (
            <ProjectField key={spec.key} spec={spec} values={values} onChange={onChange} />
          ))}
        </div>
      </div>
    ))}
  </>
);
