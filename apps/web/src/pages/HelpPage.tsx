import { Alert, Card, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHead } from '../components/PageHead';
import { AUTHORING_HELP } from '../help/authoring-help';
import '../styles/help.css';

interface PresetRow {
  key: string;
  preset: string;
  order: string;
  tie: string;
}

const PRESET_ROWS: PresetRow[] = [
  {
    key: 'oi',
    preset: 'OI',
    order: '每题取最高分求和，总分降序',
    tie: '总分相同同名次',
  },
  {
    key: 'ioi',
    preset: 'IOI',
    order: '子任务/总分求和，总分降序',
    tie: '总分相同同名次',
  },
  {
    key: 'acm',
    preset: 'ACM',
    order: '过题数降序 → 罚时升序 → 最后 AC 升序',
    tie: '三项相同同名次',
  },
  {
    key: 'cf-like',
    preset: 'CF-like',
    order: '分数降序 → 罚时升序 → 最后 AC 升序',
    tie: '三项相同同名次；可用 decay 调整时间衰减',
  },
];

const presetColumns: TableColumnsType<PresetRow> = [
  { title: '赛制', dataIndex: 'preset', width: 100 },
  { title: '排序', dataIndex: 'order' },
  { title: '默认并列', dataIndex: 'tie' },
];

export function HelpPage() {
  return (
    <div className="help-page">
      <PageHead
        breadcrumb={[{ label: '帮助' }]}
        title="帮助中心"
        subtitle="赛制、正式分、批量导入、名单、归档与排名插件的使用说明。"
        tags={
          <>
            <Tag color="blue">排名与赛制</Tag>
            <Tag color="green">批量导入</Tag>
            <Tag>插件</Tag>
          </>
        }
      />

      <div className="help-sections">
        <Card className="oij-card help-card" title="0. 出题与数据计划">
          <p>
            出题相关文档随安装包分发，位于仓库 <code>docs/help/authoring/</code>。
            下面的摘要对应已有 Markdown 文章；页面内暂不渲染 Markdown 全文。
          </p>
          <div className="help-authoring-list">
            {Object.values(AUTHORING_HELP).map((entry) => (
              <div className="help-authoring-row" key={entry.key}>
                <div>
                  <strong>{entry.title}</strong>
                  <span className="help-authoring-path mono">{entry.path}</span>
                </div>
                <p>{entry.summary}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="oij-card help-card" title="1. 赛制与排序">
          <p>
            比赛创建时选择赛制，管理员也可以在该比赛控制台的“排名规则”中随时调整。
            正式榜使用 `official-ranking` 数据；旧 `/ranking` 仅用于兼容旧数据。
          </p>
          <Table<PresetRow>
            className="oij-table"
            rowKey="key"
            size="small"
            columns={presetColumns}
            dataSource={PRESET_ROWS}
            pagination={false}
          />
          <p className="help-note">
            CF-like 不是 Codeforces 的精确复刻：它使用可配置时间衰减与罚时，不包含 hack 分。
          </p>
        </Card>

        <Card className="oij-card help-card" title="2. 并列与名次">
          <ul>
            <li>
              <strong>同分同名次（same-rank）</strong>：相同成绩共享名次，例如 1、1、3。
            </li>
            <li>
              <strong>顺序名次（none）</strong>：相同成绩按后端稳定顺序依次编号，例如 1、2、3。
            </li>
            <li>并列规则保存到比赛排名配置，刷新后仍然生效。</li>
          </ul>
        </Card>

        <Card className="oij-card help-card" title="3. 罚时">
          <ul>
            <li>ACM：首次 AC 的相对分钟数 + 该题首次 AC 前错误提交数 × 20。</li>
            <li>CF-like：与 ACM 相同，并使用可配置的时间衰减。</li>
            <li>OI/IOI：以正式分和 AC 数为主，罚时按 0 处理。</li>
          </ul>
        </Card>

        <Card className="oij-card help-card" title="4. 封榜">
          <ul>
            <li>比赛状态为“已封榜”时，正式榜按封榜时间过滤之后的提交。</li>
            <li>封榜期间提交仍会正常评测，但不计入正式榜。</li>
            <li>批量导入可以上传并预览，但发布前必须解封。</li>
            <li>解封后，封榜期间的 OI 正式分会回填。</li>
          </ul>
        </Card>

        <Card className="oij-card help-card" title="5. 归档">
          <ul>
            <li>比赛结束不等于归档；管理员在控制台点“归档比赛”才会冻结正式榜。</li>
            <li>归档后禁止批量导入发布、名单变更和在线正式分更新，正式榜只读。</li>
            <li>归档是只读快照，请确认成绩后再执行。</li>
          </ul>
        </Card>

        <Card className="oij-card help-card" title="6. 正式分与批量发布">
          <p>
            OI 正式分保存在 <code>contest_official_scores</code>：在线比赛中提交的正式成绩，
            以及已发布的批量导入成绩。批量草稿不会影响正式榜。
          </p>
          <ul>
            <li>
              <strong>覆盖</strong>：只更新批次出现的格子，即使分数更低。
            </li>
            <li>
              <strong>合并</strong>：逐格取较高分。
            </li>
            <li>
              <strong>仅补缺</strong>：只填空格，不覆盖已有正式分。
            </li>
          </ul>
          <Alert
            type="info"
            showIcon
            message="在线提交只升不降；批量发布按所选模式写入正式分。"
          />
        </Card>

        <Card className="oij-card help-card" title="7. 批量导入">
          <p>比赛控制台 → “批量导入”上传 zip。目录结构示例：</p>
          <pre className="help-code">{`Alice/1/main.cpp
Alice/3/main.cpp
Bob/1/main.cpp
Bob/3/main.cpp`}</pre>
          <ul>
            <li>学生层级默认第 1 层，题目层级默认第 2 层。</li>
            <li>题目文件夹自动匹配：题目 ID → 标题（忽略空格/大小写）→ 比赛顺序 A/B/C/D。</li>
            <li>学生文件夹必须与已注册用户名一致，大小写敏感；未知用户跳过并报告。</li>
            <li>非 OI 比赛、已归档比赛不能导入。</li>
            <li>当前支持 <code>.cpp/.cc/.cxx</code> 代码题；客观题/提交答案题将在后续阶段支持。</li>
          </ul>
          <p>流程：上传 → 草稿评测 → 预览 current→after → 选择模式 → 发布（事务）或丢弃。</p>
        </Card>

        <Card className="oij-card help-card" title="8. 名单与隐藏">
          <ul>
            <li>CSV 第一列是用户名，支持 `username` 表头；空行忽略。</li>
            <li>名单只追加；已参赛者跳过；未知用户名跳过并报告；不会自动创建账号。</li>
            <li>归档后禁止变更名单。</li>
            <li>隐藏参赛者会从正式榜移除，但成绩和提交保留；可随时恢复。</li>
          </ul>
        </Card>

        <Card className="oij-card help-card" title="9. 排名插件">
          <p>
            管理员可在“排名插件”页上传已编译的 <code>.mjs</code> 文件，并在比赛排名规则中选择
            <code>plugin:&lt;name&gt;</code>。
          </p>
          <pre className="help-code">{`export const apiVersion = 1;
export function compute(input) {
  // 返回 [{ rank, userId, totalScore, solved, penalty, lastAcAt, cells }]
}`}</pre>
          <ul>
            <li>插件由服务器在重启后加载；启用/禁用后需要重启才改变运行时行为。</li>
            <li>插件缺失、被禁用或执行失败时，正式榜回退 OI，并在数据中返回 pluginError。</li>
          </ul>
          <Alert
            type="warning"
            showIcon
            message="插件以服务器进程权限执行，等同服务器权限；只上传可信来源。"
          />
        </Card>

        <Card className="oij-card help-card" title="10. 常见问题">
          <ul>
            <li>为什么正式榜和旧榜单数字不同？正式榜包含批量发布后的官方成绩，旧榜单是兼容接口。</li>
            <li>为什么批量发布按钮不可用？检查比赛是否非 OI、已归档或已封榜。</li>
            <li>为什么插件没有生效？上传/启停后需要重启后端服务。</li>
            <li>封榜后还能提交吗？可以，提交正常评测，但不计入正式榜。</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
