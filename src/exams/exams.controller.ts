import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Headers,
  Query,
} from '@nestjs/common';
import { ExamsService } from './exams.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { UpdateExamDto } from './dto/update-exam.dto';
import { parseLang } from '../common/utils/parse-lang.util.js';
import { parseIdList, parseCount } from '../common/utils/parse-ids.util.js';

@Controller('exams')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  @Post()
  create(@Body() createExamDto: CreateExamDto) {
    return this.examsService.create(createExamDto);
  }

  @Get()
  findAll() {
    return this.examsService.findAll();
  }

  @Get('generate')
  generate(
    @Query('lang') langQuery?: string,
    @Headers('accept-language') langHeader?: string,
    @Query('title') title?: string,
    @Query('subjects') subjects?: string,
    @Query('categories') categories?: string,
    @Query('count') count?: string,
    @Query('allSubjects') allSubjects?: string,
  ) {
    return this.examsService.generateExam({
      lang: parseLang(langQuery, langHeader),
      title,
      subjects: parseIdList(subjects),
      categories: parseIdList(categories),
      count: parseCount(count),
      allSubjects: allSubjects === 'true',
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.examsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateExamDto: UpdateExamDto) {
    return this.examsService.update(id, updateExamDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.examsService.remove(id);
  }
}
