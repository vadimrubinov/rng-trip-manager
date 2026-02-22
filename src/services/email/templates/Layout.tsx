import React from "react";
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Img,
  Text,
  Hr,
  Link,
} from "@react-email/components";

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <Html lang="en">
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          {/* Header */}
          <Section style={headerStyle}>
            <Img
              src="https://bitescout.com/logo-email.png"
              alt="BiteScout"
              width="160"
              height="40"
              style={{ margin: "0 auto", display: "block" }}
            />
          </Section>

          {/* Content */}
          <Section style={contentStyle}>
            {children}
          </Section>

          {/* Footer */}
          <Hr style={hrStyle} />
          <Section style={footerStyle}>
            <Text style={footerTextStyle}>
              BiteScout — Your Fishing Trip Assistant
            </Text>
            <Text style={footerLinksStyle}>
              <Link href="https://bitescout.com" style={linkStyle}>
                bitescout.com
              </Link>
            </Text>
            <Text style={footerSmallStyle}>
              You received this email because you were invited to a trip on BiteScout.
              If you believe this was sent in error, you can safely ignore it.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

const bodyStyle: React.CSSProperties = {
  backgroundColor: "#f6f9fc",
  fontFamily: "Arial, sans-serif",
  margin: 0,
  padding: 0,
};

const containerStyle: React.CSSProperties = {
  maxWidth: "600px",
  margin: "0 auto",
  backgroundColor: "#ffffff",
  borderRadius: "8px",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  backgroundColor: "#1a73e8",
  padding: "24px 20px",
  textAlign: "center" as const,
};

const contentStyle: React.CSSProperties = {
  padding: "32px 24px",
};

const hrStyle: React.CSSProperties = {
  borderColor: "#e6ebf1",
  margin: "0 24px",
};

const footerStyle: React.CSSProperties = {
  padding: "20px 24px 28px",
  textAlign: "center" as const,
};

const footerTextStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#666",
  margin: "0 0 8px",
};

const footerLinksStyle: React.CSSProperties = {
  fontSize: "13px",
  margin: "0 0 12px",
};

const linkStyle: React.CSSProperties = {
  color: "#1a73e8",
  textDecoration: "none",
};

const footerSmallStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "#999",
  lineHeight: "1.4",
  margin: 0,
};
