import { Module } from '@nestjs/common';
import { FileanagementService } from './fileanagement.service';
import { FileanagementController } from './fileanagement.controller';
import { Fileanagement, FileanagementSchema } from './fileanagement.schema';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Fileanagement.name, schema: FileanagementSchema }]),
  ],
  controllers: [FileanagementController],
  providers: [FileanagementService],
  exports: [MongooseModule, FileanagementService],
})
export class FileanagementModule {}
