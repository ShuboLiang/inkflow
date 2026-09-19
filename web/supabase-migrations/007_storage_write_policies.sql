-- InkFlow 007: images / shares 桶的写权限
-- 006 建桶时漏了 storage.objects 策略，导致图片上传被 RLS 静默拒绝（本地缓存兜底掩盖了失败）。
--
-- 注意：storage-api 的上传是 INSERT ... ON CONFLICT DO UPDATE 单条 upsert，
-- 按命令拆分的 INSERT/UPDATE 策略会让该语句的 WITH CHECK 失败（已实测），
-- 必须和 files 桶一样用单条 FOR ALL 策略。

create policy "users manage images" on storage.objects
  for all using (bucket_id = 'images' and auth.uid() is not null)
  with check (bucket_id = 'images' and auth.uid() is not null);

create policy "users manage shares" on storage.objects
  for all using (bucket_id = 'shares' and auth.uid() is not null)
  with check (bucket_id = 'shares' and auth.uid() is not null);
