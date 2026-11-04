import type { AwardRow, TeamAwardRow } from '../api/types';
import { awardLabel, isTeamAwardRow } from '../utils/awards';

export interface AwardCertificateProps {
  contestName: string;
  /** 个人奖行或团队奖行；组件按是否含 teamId 区分。 */
  row: AwardRow | TeamAwardRow;
  /** 证书日期（已在调用方按比赛结束时间格式化）。 */
  date: string;
  /** 签发单位，默认使用赛事平台名。 */
  issuer?: string;
}

/**
 * 打印专用证书版式：比赛名/姓名或团队名/名次/奖项/证书编号/日期。
 * 团队证书额外展示成员数。屏幕上默认不显示，仅在打印媒体中由
 * `.award-print-area` 容器展示。
 */
export function AwardCertificate({
  contestName,
  row,
  date,
  issuer = 'OiJudge 赛事组委会',
}: AwardCertificateProps) {
  const team = isTeamAwardRow(row) ? row : null;
  const individual = team === null ? (row as AwardRow) : null;
  const name = team ? team.teamName : (individual?.realName ?? individual?.username ?? '');
  return (
    <article
      className={`award-certificate award-certificate-${row.award ?? 'none'}${
        team ? ' award-certificate-team' : ''
      }`}
      aria-label={`${name} 的${team ? '团队' : ''}获奖证书`}
    >
      <div className="award-certificate-frame">
        <div className="award-certificate-brand">OI LOCAL JUDGE</div>
        <h1 className="award-certificate-title">荣 誉 证 书</h1>
        <p className="award-certificate-prefix">{team ? '兹证明团队' : '兹证明'}</p>
        <p className="award-certificate-name">{name}</p>
        {team ? (
          <p className="award-certificate-class">团队 · 共 {team.memberCount} 名成员</p>
        ) : individual?.className ? (
          <p className="award-certificate-class">{individual.className}</p>
        ) : null}
        <p className="award-certificate-text">
          在 <strong>{contestName}</strong> 中表现优异，荣获
        </p>
        <p className="award-certificate-award">{awardLabel(row.award)}</p>
        <p className="award-certificate-meta">
          第 {row.rank} 名 · 总分 {row.totalScore} · 解出 {row.solved} 题
        </p>
        <div className="award-certificate-footer">
          <span>证书编号：{row.certificateNo}</span>
          <span>{issuer}</span>
          <span>{date}</span>
        </div>
      </div>
    </article>
  );
}
