import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("documents-list", async (params) => {
      const companyId = params.companyId as string;
      const search = (params.search as string) || "";
      const limit = Math.min(Number(params.limit) || 50, 100);

      let query = `
        SELECT d.id, d.title, d.format, d.latest_revision_number as revision,
               d.created_at, d.updated_at,
               LEFT(d.latest_body, 200) as body_preview,
               a.name as author_name,
               i.identifier as issue_identifier, i.title as issue_title,
               p.name as project_name
        FROM public.documents d
        LEFT JOIN public.agents a ON a.id = d.created_by_agent_id
        LEFT JOIN public.issue_documents id ON id.document_id = d.id
        LEFT JOIN public.issues i ON i.id = id.issue_id
        LEFT JOIN public.projects p ON p.id = i.project_id
        WHERE d.company_id = $1
      `;
      const args: unknown[] = [companyId];

      if (search) {
        query += ` AND (d.title ILIKE $2 OR d.latest_body ILIKE $2)`;
        args.push(`%${search}%`);
      }

      query += ` ORDER BY d.updated_at DESC LIMIT $${args.length + 1}`;
      args.push(limit);

      return ctx.db.query(query, args);
    });

    ctx.data.register("document-detail", async (params) => {
      const documentId = params.documentId as string;
      if (!documentId) return null;

      const docs = await ctx.db.query(
        `SELECT d.*, a.name as author_name,
                i.identifier as issue_identifier, i.title as issue_title, i.id as issue_id,
                p.name as project_name
         FROM public.documents d
         LEFT JOIN public.agents a ON a.id = d.created_by_agent_id
         LEFT JOIN public.issue_documents id ON id.document_id = d.id
         LEFT JOIN public.issues i ON i.id = id.issue_id
         LEFT JOIN public.projects p ON p.id = i.project_id
         WHERE d.id = $1`,
        [documentId],
      );
      return docs.length > 0 ? docs[0] : null;
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
