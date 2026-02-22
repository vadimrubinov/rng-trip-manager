import React from "react";
import { render } from "@react-email/render";
import { Layout } from "./templates/Layout";
import { Section } from "@react-email/components";

/**
 * Wraps raw body HTML from Airtable template in the branded Layout
 * and renders to a full HTML email string.
 */
export function renderEmail(bodyHtml: string): string {
  const element = React.createElement(
    Layout,
    null,
    React.createElement(Section, {
      dangerouslySetInnerHTML: { __html: bodyHtml },
    })
  );

  // @react-email/render sync mode (CommonJS-compatible)
  return render(element) as unknown as string;
}

/**
 * Replaces {{variable}} placeholders in a string with values from the map.
 */
export function interpolateVariables(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}
