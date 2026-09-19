-- InkFlow 006: 笔记图片走公共桶 images
-- 正文 img src 存公共 URL（分享页免鉴权直接可看；uuid 路径不可枚举，隐私模型同分享链接）。
-- 对象直接放在桶根，文件名 = uuid + 扩展名。

insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;
