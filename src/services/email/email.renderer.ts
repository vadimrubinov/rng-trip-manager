import React from "react";
import { render } from "@react-email/render";
import { Layout } from "./templates/Layout";

/**
 * Wraps raw body HTML from Airtable template in the branded Layout
 * and renders to a full HTML email string.
 */
export async function renderEmail(bodyHtml: string): Promise<string> {
  const element = React.createElement(
    Layout,
    null,
    // Use plain div with dangerouslySetInnerHTML (React Email Section doesn't support it)
    React.createElement("div", {
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
