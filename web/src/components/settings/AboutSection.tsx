import { useState } from 'react';
import { Github, ExternalLink, Heart, Code2, Bug } from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">
          SalesClaw
        </h2>
        <p className="text-sm text-muted-foreground">
          面向销售 SOP 与客户运营的自托管 Agent 工作台
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          版本 1.0.0 · MIT License
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href="https://github.com/Xx-173/salesclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            Xx-173/salesclaw
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground">维护者：Xx-173</span>
        </div>
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-muted-foreground shrink-0" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBugReport(true)}
          >
            <Bug className="w-3.5 h-3.5" />
            报告问题
          </Button>
        </div>
      </div>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      <hr className="border-border" />

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-medium text-foreground">产品原则</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          在统一的工作区中管理客户运营 Agent、知识与渠道能力，并以最小权限、可审计动作和人工接管为销售自动化场景预留治理边界。
        </p>
      </div>
    </div>
  );
}
