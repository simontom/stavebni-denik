import React from "react";
import { CORE, LONGEST_LIST, LONGEST_NAME, SECTIONS, type FieldSpec, type ProjectFieldValues } from "../lib/projectFields";

const inputClass = "w-full rounded-md border border-gray-300 p-2 focus:border-indigo-500 focus:ring-indigo-500";

const Field: React.FC<{ spec: FieldSpec; values: ProjectFieldValues; onChange: (patch: Partial<ProjectFieldValues>) => void }> = ({ spec, values, onChange }) => {
  const id = `project-${spec.key}`;
  const value = values[spec.key];
  return (
    <div className={spec.type === "textarea" ? "md:col-span-2" : undefined}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700">
        {spec.label}
      </label>
      {spec.type === "textarea" ? (
        <textarea id={id} name={spec.key} value={value} onChange={(e) => onChange({ [spec.key]: e.target.value })} rows={3} placeholder={spec.placeholder} className={inputClass} />
      ) : (
        <input
          id={id}
          name={spec.key}
          type={spec.type ?? "text"}
          required={spec.required}
          maxLength={spec.type === "date" ? undefined : LONGEST_NAME}
          value={value}
          onChange={(e) => onChange({ [spec.key]: e.target.value })}
          placeholder={spec.placeholder}
          className={inputClass}
        />
      )}
      {spec.type === "textarea" && value.length > LONGEST_LIST * 0.9 && (
        <p className={`mt-1 text-xs ${value.length > LONGEST_LIST ? "font-semibold text-red-700" : "text-gray-600"}`}>
          {value.length} / {LONGEST_LIST} znaků
        </p>
      )}
    </div>
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
        <Field key={spec.key} spec={spec} values={values} onChange={onChange} />
      ))}
      {children}
    </div>
    {SECTIONS.map((section) => (
      <div key={section.title} className="mt-4 border-t border-gray-200 pt-4">
        <h2 className="text-md mb-3 font-semibold text-gray-800">{section.title}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {section.fields.map((spec) => (
            <Field key={spec.key} spec={spec} values={values} onChange={onChange} />
          ))}
        </div>
      </div>
    ))}
  </>
);
