/** Recover model-generated absolute image paths containing unescaped spaces.
 * Work only on text nodes, so code examples remain literal Markdown.
 */
export function remarkLocalImages() {
  return (tree: any) => {
    const visit = (parent: any) => {
      if (!parent.children || ['code', 'inlineCode', 'link', 'image'].includes(parent.type)) return;
      parent.children = parent.children.flatMap((node: any) => {
        if (node.type !== 'text') { visit(node); return [node]; }
        const pattern = /!\[([^\]\n]*)\]\((\/[^\n<>]*?\.(?:png|jpe?g|gif|webp|avif))\)/gi;
        const result: any[] = []; let offset = 0;
        for (const match of node.value.matchAll(pattern)) {
          if (match.index > offset) result.push({type:'text', value:node.value.slice(offset, match.index)});
          result.push({type:'image', url:encodeURI(match[2]).replace(/#/g, '%23').replace(/\?/g, '%3F'), alt:match[1]});
          offset = match.index + match[0].length;
        }
        if (!offset) return [node];
        if (offset < node.value.length) result.push({type:'text',value:node.value.slice(offset)});
        return result;
      });
    };
    visit(tree);
  };
}
