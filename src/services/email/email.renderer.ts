import React from "react";
import { render } from "@react-email/render";
import { Layout } from "./templates/Layout";
import { Section } from "@react-email/components";

/**
 * Wraps raw body HTML from Airtable template in the branded Layout
 * and renders to a full HTML email string.
 */
export async function renderEmail(bodyHtml: string): Promise<string> {
  const element = React.createElement(
    Layout,
    null,
    React.createElement(Section, {
      dangerouslySetInnerHTML: { __html: bodyHtml },
    })
  );

  return await render(element);
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
