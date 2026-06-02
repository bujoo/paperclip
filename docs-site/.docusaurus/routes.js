import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/docs',
    component: ComponentCreator('/docs', '41a'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', 'e1e'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', '379'),
            routes: [
              {
                path: '/docs/',
                component: ComponentCreator('/docs/', 'be8'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/agents/debugging',
                component: ComponentCreator('/docs/agents/debugging', '197'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/agents/execution',
                component: ComponentCreator('/docs/agents/execution', '4dc'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/agents/mcp-setup',
                component: ComponentCreator('/docs/agents/mcp-setup', '5cd'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference/agents',
                component: ComponentCreator('/docs/api-reference/agents', 'd7c'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference/circles',
                component: ComponentCreator('/docs/api-reference/circles', '4b4'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference/issues',
                component: ComponentCreator('/docs/api-reference/issues', '810'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference/overview',
                component: ComponentCreator('/docs/api-reference/overview', 'c96'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/getting-started/onboard-agent',
                component: ComponentCreator('/docs/getting-started/onboard-agent', '0e7'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/getting-started/overview',
                component: ComponentCreator('/docs/getting-started/overview', '557'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/getting-started/raise-tension',
                component: ComponentCreator('/docs/getting-started/raise-tension', 'abf'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/governance/circles',
                component: ComponentCreator('/docs/governance/circles', '0ea'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/governance/governance-meeting',
                component: ComponentCreator('/docs/governance/governance-meeting', '32f'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/governance/roles',
                component: ComponentCreator('/docs/governance/roles', '646'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/governance/tactical-meeting',
                component: ComponentCreator('/docs/governance/tactical-meeting', '167'),
                exact: true,
                sidebar: "docs"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
