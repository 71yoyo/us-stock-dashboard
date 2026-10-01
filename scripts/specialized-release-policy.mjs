// 연결 저장소의 feature branch도 preview/version upload를 실행할 수 있다. 이름만으로 안전하다고 승인하지 않는다.
export function backupPolicy({ pagesPreviewAll, workerNonProductionBuilds }) {
  if (pagesPreviewAll || workerNonProductionBuilds) return {
    connectedRepositoryPushAllowed:false,
    recommendation:'git bundle를 생성하고 Cloudflare와 연결되지 않은 별도 비공개 저장소에 업로드'
  };
  return { connectedRepositoryPushAllowed:false,
    recommendation:'실제 branch filter와 대상 branch를 별도 확인한 뒤 승인 필요' };
}
