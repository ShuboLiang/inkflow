-- InkFlow 007: images / shares 桶的写权限
-- 006 建桶时漏了 storage.objects 策略，导致图片上传被 RLS 静默拒绝（本地缓存兜底掩盖了失败）。
-- images（公共读）：登录用户可写任意路径（文件名是 uuid，天然隔离）
-- shares（公共读）：登录用户可写/删（对象以分享 token 命名，撤销时删除）

create policy "authenticated write images" on storage.objects
  for insert to authenticated with check (bucket_id = 'images');
create policy "authenticated update images" on storage.objects
  for update to authenticated using (bucket_id = 'images');
create policy "authenticated delete images" on storage.objects
  for delete to authenticated using (bucket_id = 'images');

create policy "authenticated write shares" on storage.objects
  for insert to authenticated with check (bucket_id = 'shares');
create policy "authenticated update shares" on storage.objects
  for update to authenticated using (bucket_id = 'shares');
create policy "authenticated delete shares" on storage.objects
  for delete to authenticated using (bucket_id = 'shares');
