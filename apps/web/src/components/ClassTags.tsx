import { Tag } from 'antd';
import type { ClassRole } from '../api/types';
import { CLASS_ROLE_TAG_COLOR, classRoleLabel } from '../utils/classes';

/** 班级身份标签：教练 / 助教 / 学生。 */
export function ClassRoleTag({ role }: { role: ClassRole }) {
  return <Tag color={CLASS_ROLE_TAG_COLOR[role] ?? 'blue'}>{classRoleLabel(role)}</Tag>;
}

/** 班级是否允许学生以班级为单位参加比赛。 */
export function AllowContestTag({ allow }: { allow: boolean }) {
  return allow ? <Tag color="green">允许参赛</Tag> : <Tag>不允许参赛</Tag>;
}
