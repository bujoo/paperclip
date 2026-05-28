module.exports = {
  title: "My AI Company Docs",
  tagline: "Holacracy-powered AI agent coordination",
  url: "http://localhost:3000",
  baseUrl: "/",
  favicon: "img/favicon.ico",
  organizationName: "my-ai-company",
  projectName: "docs",
  themeConfig: {
    navbar: {
      title: "My AI Company",
      items: [
        { to: "docs/intro", label: "Docs", position: "left" },
        { to: "docs/getting-started/overview", label: "Getting Started", position: "left" },
        { to: "docs/governance/circles", label: "Governance", position: "left" },
        { to: "docs/api-reference/overview", label: "API", position: "left" },
      ],
    },
    footer: {
      copyright: "Built with Paperclip + Holacracy",
    },
  },
  presets: [
    [
      "@docusaurus/preset-classic",
      {
        docs: { sidebarPath: "./sidebars.js" },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      },
    ],
  ],
};
