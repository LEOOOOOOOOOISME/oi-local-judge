import { Button, Result } from 'antd';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在，或你访问的地址有误。"
      extra={
        <Link to="/contests">
          <Button type="primary">返回比赛列表</Button>
        </Link>
      }
    />
  );
}
