import { useRef, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { studio } from '../lib/util';

// HTML bruto NÃO é renderizado (react-markdown ignora tags). Imagens remotas ficam bloqueadas
// (além da CSP): mostramos só o texto alternativo. Links abrem no navegador do sistema, só https público.

function CodeBlock(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="codeblock">
      <button className="copy" onClick={() => void navigator.clipboard.writeText(ref.current?.textContent ?? '')} aria-label="Copiar código">
        Copiar
      </button>
      <pre ref={ref}>{props.children}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void studio().system.openExternal(href).catch(() => undefined);
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="muted">[imagem: {alt || 'sem descrição'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
