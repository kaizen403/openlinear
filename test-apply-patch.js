const fs = require('fs');
let code = fs.readFileSync('apps/desktop-ui/components/board/kanban-board.tsx', 'utf8');

if (!code.includes("import { ModelSelector }")) {
  code = code.replace('import { DoneColumnContent } from "./done-column-content"\nimport { useRouter } from "next/navigation"', 'import { DoneColumnContent } from "./done-column-content"\nimport { ModelSelector } from "./model-selector"\nimport { useRouter } from "next/navigation"');
}

if (!code.includes("<ModelSelector />")) {
  code = code.replace('<Icon className={`w-3 h-3 flex-shrink-0 ${tone.icon}`} />', '<Icon className={`w-3 h-3 flex-shrink-0 ${tone.icon}`} />');
  
  // Actually we need to add ModelSelector as an item in the ProjectConfigPanel list or insert it as a child.
  // Wait, let's just insert it after the items map
  const insertionPoint = `              )
            })}
            <ModelSelector />
          </div>
        </div>`;
  
  code = code.replace(`              )
            })}
          </div>
        </div>`, insertionPoint);
}

fs.writeFileSync('apps/desktop-ui/components/board/kanban-board.tsx', code);
console.log("Done");
