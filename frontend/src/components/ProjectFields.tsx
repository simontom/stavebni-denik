import React from "react";
import { CORE, SECTIONS, limitOf, type FieldSpec, type ProjectFieldValues } from "../lib/projectFields";
import { Field, TextArea, TextInput } from "./ui";

const ProjectField: React.FC<{ spec: FieldSpec; values: ProjectFieldValues; onChange: (patch: Partial<ProjectFieldValues>) => void }> = ({ spec, values, onChange }) => {
  const value = values[spec.key];
  const limit = limitOf(spec);
  const id = `project-${spec.key}`;
  const tooLong = limit !== null && value.length > limit;
  // Near the limit the count is a note tied to the field; over it, it is the field's error (the field is marked invalid and the count is announced).
  const counting = limit !== null && !tooLong && value.length > limit * 0.9;
  const countId = `${id}-count`;
  return (
    <Field
      id={id}
      label={spec.label}
      hint={spec.hint}
      error={tooLong ? `Text je příliš dlouhý: ${value.length} / ${limit} znaků.` : undefined}
      errorRole="status"
      className={spec.type === "textarea" ? "md:col-span-2" : undefined}
    >
      {spec.type === "textarea" ? (
        <TextArea
          name={spec.key}
          value={value}
          onChange={(e) => onChange({ [spec.key]: e.target.value })}
          rows={3}
          placeholder={spec.placeholder}
          aria-describedby={counting ? countId : undefined}
        />
      ) : (
        <TextInput
          name={spec.key}
          type={spec.type ?? "text"}
          required={spec.required}
          value={value}
          onChange={(e) => onChange({ [spec.key]: e.target.value })}
          placeholder={spec.placeholder}
          aria-describedby={counting ? countId : undefined}
        />
      )}
      {counting && (
        <p id={countId} className="mt-1 text-xs text-ink-muted">
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
        <h2 className="mb-3 text-base font-semibold text-ink">{section.title}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {section.fields.map((spec) => (
            <ProjectField key={spec.key} spec={spec} values={values} onChange={onChange} />
          ))}
        </div>
      </div>
    ))}
  </>
);
