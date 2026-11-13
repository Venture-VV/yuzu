-- 管家服务引用系统原有资源，不另建房间/包间名录；旧手写资源保留。
ALTER TABLE concierge_records
 ADD COLUMN native_space_id bigint REFERENCES spaces(id),
 ADD COLUMN native_table_id bigint REFERENCES dining_tables(id),
 ADD COLUMN native_room_id bigint REFERENCES rooms(id),
 ADD CONSTRAINT concierge_resource_one CHECK (num_nonnulls(native_space_id,native_table_id,native_room_id)<=1),
 ADD CONSTRAINT concierge_resource_appointment CHECK (kind='appointment' OR num_nonnulls(native_space_id,native_table_id,native_room_id)=0);
CREATE INDEX concierge_space_appointments ON concierge_records(native_space_id) WHERE native_space_id IS NOT NULL;
CREATE INDEX concierge_table_appointments ON concierge_records(native_table_id) WHERE native_table_id IS NOT NULL;
CREATE INDEX concierge_room_appointments ON concierge_records(native_room_id) WHERE native_room_id IS NOT NULL;
